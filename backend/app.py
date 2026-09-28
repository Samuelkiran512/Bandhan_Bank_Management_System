from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import MongoClient
from werkzeug.security import check_password_hash, generate_password_hash
from bson import ObjectId
from datetime import datetime, timedelta
import os
import jwt
import uuid
import re
import smtplib
import ssl
import secrets
import hashlib
from email.message import EmailMessage
import resend
from collections import defaultdict, deque
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# ---------------- FINAL SECURITY HARDENING ----------------
# Reject unexpectedly large request bodies early.
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024
# ---------------- CORS / SECURITY CONFIGURATION ----------------

# Allow only the frontend origins configured in backend/.env.
# For local development, both Vite default ports are allowed.
FRONTEND_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://localhost:5174"
    ).split(",")
    if origin.strip()
]

CORS(
    app,
    resources={r"/*": {"origins": FRONTEND_ORIGINS}},
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=[],
    supports_credentials=False
)


@app.after_request
def add_security_headers(response):
    # Prevent MIME-type sniffing.
    response.headers["X-Content-Type-Options"] = "nosniff"

    # Prevent the API from being embedded in a frame.
    response.headers["X-Frame-Options"] = "DENY"

    # Limit referrer information sent by the browser.
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    # API responses should not be stored by shared/browser caches.
    response.headers["Cache-Control"] = "no-store"

    # Reduce browser-side cross-origin data exposure.
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Resource-Policy"] = "same-site"

    # Do not advertise the framework/server implementation.
    response.headers.pop("Server", None)

    # Give support/debugging a harmless correlation ID without exposing internals.
    response.headers["X-Request-ID"] = getattr(request, "request_id", str(uuid.uuid4()))

    return response

JWT_SECRET = os.getenv("JWT_SECRET")
MONGO_URI = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "bandhan_bank_management")
JWT_EXPIRES_HOURS = int(os.getenv("JWT_EXPIRES_HOURS", "8"))
JWT_ISSUER = os.getenv("JWT_ISSUER", "bandhan-bank-management")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "bandhan-bank-frontend")
JWT_LEEWAY_SECONDS = 30
REVOKED_TOKENS = set()

# ---------------- EMAIL / PASSWORD RESET CONFIGURATION ----------------
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "Bandhan Bank Management System")

# Resend email configuration (preferred for OTP/target emails).
# Existing SMTP configuration is intentionally kept as a fallback.
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
RESEND_FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "onboarding@resend.dev").strip()

OTP_EXPIRES_MINUTES = int(os.getenv("OTP_EXPIRES_MINUTES", "5"))
OTP_MAX_ATTEMPTS = int(os.getenv("OTP_MAX_ATTEMPTS", "5"))

if not JWT_SECRET or len(JWT_SECRET) < 32:
    raise RuntimeError(
        "JWT_SECRET is missing or too short. Add a strong JWT_SECRET to backend/.env."
    )
LOGIN_ATTEMPTS = {}
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCK_MINUTES = 10

# ---------------- RATE LIMITING ----------------
# Lightweight in-memory limits for local/dev protection.
RATE_LIMITS = {
    "login": {"max_requests": 10, "window_seconds": 60},
    "api": {"max_requests": 120, "window_seconds": 60},
}
RATE_REQUESTS = defaultdict(deque)

def get_client_ip():
    return request.remote_addr or "unknown"

def rate_limit_exceeded(bucket, max_requests, window_seconds):
    key = f"{bucket}:{get_client_ip()}"
    now = datetime.utcnow().timestamp()
    requests = RATE_REQUESTS[key]
    while requests and now - requests[0] >= window_seconds:
        requests.popleft()
    if len(requests) >= max_requests:
        retry_after = max(1, int(window_seconds - (now - requests[0])))
        return True, retry_after
    requests.append(now)
    return False, 0

@app.before_request
def apply_rate_limits():
    if request.method == "OPTIONS":
        return None

    path = request.path
    if path in ("/admin/login", "/staff/login"):
        exceeded, retry_after = rate_limit_exceeded(
            "login", RATE_LIMITS["login"]["max_requests"], RATE_LIMITS["login"]["window_seconds"]
        )
        if exceeded:
            response = jsonify({
                "success": False,
                "message": "Too many requests. Please try again later."
            })
            response.status_code = 429
            response.headers["Retry-After"] = str(retry_after)
            return response

    # Apply a broader limit to API endpoints while leaving OPTIONS preflight alone.
    if path.startswith("/admin/") or path.startswith("/staff/") or path == "/auth/logout":
        exceeded, retry_after = rate_limit_exceeded(
            "api", RATE_LIMITS["api"]["max_requests"], RATE_LIMITS["api"]["window_seconds"]
        )
        if exceeded:
            response = jsonify({
                "success": False,
                "message": "Too many requests. Please slow down and try again later."
            })
            response.status_code = 429
            response.headers["Retry-After"] = str(retry_after)
            return response

    return None


def normalize_login_id(value):
    return str(value or "").strip().lower()


def get_login_key(role, user_id):
    return f"{role}:{normalize_login_id(user_id)}:{request.remote_addr or 'unknown'}"


def is_login_locked(key):
    record = LOGIN_ATTEMPTS.get(key)
    if not record:
        return False, 0
    locked_until = record.get("locked_until")
    if locked_until and datetime.utcnow() < locked_until:
        remaining = max(1, int((locked_until - datetime.utcnow()).total_seconds() // 60) + 1)
        return True, remaining
    if locked_until and datetime.utcnow() >= locked_until:
        LOGIN_ATTEMPTS.pop(key, None)
    return False, 0


def record_failed_login(key):
    record = LOGIN_ATTEMPTS.setdefault(key, {"count": 0, "locked_until": None})
    record["count"] += 1
    if record["count"] >= MAX_LOGIN_ATTEMPTS:
        record["locked_until"] = datetime.utcnow() + timedelta(minutes=LOGIN_LOCK_MINUTES)
        return True
    return False


def clear_login_attempts(key):
    LOGIN_ATTEMPTS.pop(key, None)


def valid_email(email):
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", str(email or "").strip()))


def valid_phone(phone):
    if phone in (None, ""):
        return True
    return bool(re.fullmatch(r"\d{10}", str(phone).strip()))


def valid_date(value):
    try:
        datetime.strptime(str(value), "%Y-%m-%d")
        return True
    except (TypeError, ValueError):
        return False


PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 8 characters and contain at least one uppercase "
    "letter, one lowercase letter, one number and one special character."
)

COMMON_WEAK_PASSWORDS = {
    "password",
    "password123",
    "password@123",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty123",
    "admin123",
    "admin@123",
    "welcome123",
    "letmein123",
}


def validate_password(password):
    password = str(password or "")
    if len(password) < 8 or len(password) > 128:
        return False, PASSWORD_POLICY_MESSAGE
    if password.lower() in COMMON_WEAK_PASSWORDS:
        return False, "This password is too common. Please choose a stronger password."
    if not re.search(r"[A-Z]", password):
        return False, PASSWORD_POLICY_MESSAGE
    if not re.search(r"[a-z]", password):
        return False, PASSWORD_POLICY_MESSAGE
    if not re.search(r"\d", password):
        return False, PASSWORD_POLICY_MESSAGE
    if not re.search(r"[^A-Za-z0-9]", password):
        return False, PASSWORD_POLICY_MESSAGE
    return True, ""

def create_access_token(user_id, role, name=""):
    payload = {
        "user_id": user_id,
        "role": role,
        "name": name,
        "jti": str(uuid.uuid4()),
        "iat": datetime.utcnow(),
        "nbf": datetime.utcnow(),
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRES_HOURS),
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "typ": "access"
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=5000,
    connectTimeoutMS=5000,
    socketTimeoutMS=10000,
    retryWrites=True
)
db = client[MONGO_DB_NAME]

users_collection = db["users"]
admins_collection = db["admins"]
staff_collection = db["staff"]
targets_collection = db["targets"]
notifications_collection = db["notifications"]
audit_logs_collection = db["audit_logs"]
password_resets_collection = db["password_resets"]

# ---------------- DATABASE SECURITY / PERFORMANCE INDEXES ----------------
# Keep frequently queried identity fields unique so duplicate accounts cannot
# be created accidentally. These indexes also make authentication lookups fast.
try:
    staff_collection.create_index("staff_id", unique=True, name="uq_staff_id")
    staff_collection.create_index("email", unique=True, name="uq_staff_email")
    admins_collection.create_index("user_id", unique=True, name="uq_admin_user_id")

    # Common target and notification lookups.
    targets_collection.create_index(
        [("staff_id", 1), ("status", 1), ("_id", -1)],
        name="idx_targets_staff_status"
    )
    targets_collection.create_index(
        [("status", 1), ("_id", -1)],
        name="idx_targets_status"
    )
    notifications_collection.create_index(
        [("role", 1), ("user_id", 1), ("_id", -1)],
        name="idx_notifications_user"
    )

    # Audit logs are primarily read newest-first.
    audit_logs_collection.create_index(
        [("created_at", -1)],
        name="idx_audit_created_at"
    )
    password_resets_collection.create_index(
        "expires_at",
        expireAfterSeconds=0,
        name="ttl_password_reset_expiry"
    )
except Exception:
    # Do not prevent the application from starting if an index already exists
    # or a development database temporarily has an index conflict.
    pass




def get_token_from_request():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    return auth_header.split(" ", 1)[1].strip()


def verify_token(required_role=None):
    token = get_token_from_request()
    if not token:
        return None, (jsonify({"success": False, "message": "Authentication required."}), 401)
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=["HS256"],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
            leeway=JWT_LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "nbf", "jti", "user_id", "role", "iss", "aud"]}
        )
        if payload.get("typ") != "access":
            return None, (jsonify({"success": False, "message": "Invalid authentication token."}), 401)
        if payload.get("jti") in REVOKED_TOKENS:
            return None, (jsonify({"success": False, "message": "Session has been logged out. Please login again."}), 401)
        if required_role and payload.get("role") != required_role:
            return None, (jsonify({"success": False, "message": "Access denied."}), 403)
        return payload, None
    except jwt.ExpiredSignatureError:
        return None, (jsonify({"success": False, "message": "Session expired. Please login again."}), 401)
    except jwt.ImmatureSignatureError:
        return None, (jsonify({"success": False, "message": "Authentication token is not active yet."}), 401)
    except jwt.InvalidTokenError:
        return None, (jsonify({"success": False, "message": "Invalid authentication token."}), 401)


def admin_required(view_function):
    from functools import wraps
    @wraps(view_function)
    def wrapped(*args, **kwargs):
        payload, error = verify_token("admin")
        if error:
            return error
        request.current_user = payload
        return view_function(*args, **kwargs)
    return wrapped


def staff_required(view_function):
    from functools import wraps
    @wraps(view_function)
    def wrapped(*args, **kwargs):
        payload, error = verify_token("staff")
        if error:
            return error
        request.current_user = payload
        return view_function(*args, **kwargs)
    return wrapped


def serialize_target(target):
    target = dict(target)
    target["_id"] = str(target["_id"])
    return target


def create_audit_log(action, description, actor_role=None, actor_id=None, target_type=None, target_id=None, metadata=None):
    try:
        audit_logs_collection.insert_one({
            "action": action,
            "description": description,
            "actor_role": actor_role or (getattr(request, "current_user", None) or {}).get("role"),
            "actor_id": actor_id or (getattr(request, "current_user", None) or {}).get("user_id"),
            "target_type": target_type,
            "target_id": str(target_id) if target_id else None,
            "metadata": metadata or {},
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "ip_address": request.remote_addr or "unknown"
        })
    except Exception:
        pass


def create_notification(title, message, role, user_id=None):
    notifications_collection.insert_one({
        "title": title,
        "message": message,
        "role": role,
        "user_id": user_id,
        "read": False,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M")
    })


def hash_otp(otp):
    return hashlib.sha256(str(otp).encode("utf-8")).hexdigest()


def send_email(to_email, subject, body):
    # ------------------------------------------------------------
    # 1) Resend is preferred when RESEND_API_KEY is configured.
    # 2) Existing Gmail/SMTP setup remains as a fallback.
    # ------------------------------------------------------------
    if RESEND_API_KEY:
        try:
            resend.api_key = RESEND_API_KEY
            resend.Emails.send({
                "from": f"{SMTP_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "text": body
            })
            return True, ""
        except Exception:
            # If Resend fails, try the existing SMTP configuration below.
            pass

    # Existing SMTP email method kept unchanged as fallback.
    if not SMTP_USERNAME or not SMTP_PASSWORD or not SMTP_FROM_EMAIL:
        if RESEND_API_KEY:
            return False, "Unable to send email."
        return False, "Email service is not configured."

    try:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM_EMAIL}>"
        message["To"] = to_email
        message.set_content(body)
        context = ssl.create_default_context()
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
            server.send_message(message)
        return True, ""
    except Exception:
        return False, "Unable to send email."

@app.route("/auth/logout", methods=["POST"])
def logout():
    token = get_token_from_request()
    if token:
        try:
            payload = jwt.decode(
                token,
                JWT_SECRET,
                algorithms=["HS256"],
                issuer=JWT_ISSUER,
                audience=JWT_AUDIENCE,
                options={"verify_exp": False}
            )
            jti = payload.get("jti")
            if jti:
                REVOKED_TOKENS.add(jti)
        except jwt.InvalidTokenError:
            pass
    return jsonify({"success": True, "message": "Logged out successfully."}), 200


@app.route("/")
def home():
    return jsonify({"message": "Bandhan Bank Management System Backend is Working!"})


@app.before_request
def assign_request_id():
    request.request_id = str(uuid.uuid4())


@app.errorhandler(400)
def handle_bad_request(error):
    return jsonify({
        "success": False,
        "message": "Invalid request.",
        "request_id": getattr(request, "request_id", None)
    }), 400


@app.errorhandler(401)
def handle_unauthorized(error):
    return jsonify({
        "success": False,
        "message": "Authentication required.",
        "request_id": getattr(request, "request_id", None)
    }), 401


@app.errorhandler(403)
def handle_forbidden(error):
    return jsonify({
        "success": False,
        "message": "Access denied.",
        "request_id": getattr(request, "request_id", None)
    }), 403


@app.errorhandler(404)
def handle_not_found(error):
    return jsonify({
        "success": False,
        "message": "Resource not found.",
        "request_id": getattr(request, "request_id", None)
    }), 404


@app.errorhandler(405)
def handle_method_not_allowed(error):
    return jsonify({
        "success": False,
        "message": "Method not allowed.",
        "request_id": getattr(request, "request_id", None)
    }), 405


@app.errorhandler(413)
def handle_request_too_large(error):
    return jsonify({
        "success": False,
        "message": "Request is too large.",
        "request_id": getattr(request, "request_id", None)
    }), 413


@app.errorhandler(429)
def handle_too_many_requests(error):
    response = jsonify({
        "success": False,
        "message": "Too many requests. Please try again later.",
        "request_id": getattr(request, "request_id", None)
    })
    retry_after = getattr(error, "retry_after", None)
    if retry_after:
        response.headers["Retry-After"] = str(retry_after)
    return response, 429


@app.errorhandler(500)
def handle_internal_error(error):
    # Never return exception text, stack traces, file paths, DB details, or secrets.
    return jsonify({
        "success": False,
        "message": "Internal server error. Please try again later.",
        "request_id": getattr(request, "request_id", None)
    }), 500


@app.route("/config-status")
@admin_required
def config_status():
    return jsonify({
        "success": True,
        "jwt_configured": bool(JWT_SECRET),
        "jwt_secret_length_ok": len(JWT_SECRET) >= 32,
        "mongo_configured": bool(MONGO_URI),
        "cors_configured": bool(FRONTEND_ORIGINS),
        "rate_limit_configured": True,
        "jwt_issuer_configured": bool(JWT_ISSUER),
        "jwt_audience_configured": bool(JWT_AUDIENCE),
        "jwt_expires_hours": JWT_EXPIRES_HOURS
    })


@app.route("/test-db")
@admin_required
def test_db():
    try:
        collections = db.list_collection_names()
        return jsonify({"message": "MongoDB Connected Successfully!", "collections": collections})
    except Exception as e:
        return jsonify({"message": "MongoDB Connection Failed!", "request_id": getattr(request, "request_id", None)}), 500

@app.route("/admin/login", methods=["POST"])
def admin_login():
    try:
        data = request.get_json() or {}

        user_id = str(data.get("user_id") or "").strip()
        password = str(data.get("password") or "")

        if not user_id or not password:
            return jsonify({
                "success": False,
                "message": "User ID and password are required."
            }), 400

        if len(user_id) > 120 or len(password) > 128:
            return jsonify({
                "success": False,
                "message": "Invalid login input."
            }), 400

        key = get_login_key("admin", user_id)

        locked, minutes = is_login_locked(key)

        if locked:
            return jsonify({
                "success": False,
                "message": f"Too many failed attempts. Try again in about {minutes} minutes."
            }), 429

        admin = admins_collection.find_one(
            {"user_id": user_id},
            {
                "_id": 0,
                "user_id": 1,
                "role": 1,
                "name": 1,
                "status": 1,
                "password": 1
            }
        )

        if (
            not admin
            or admin.get("status") != "active"
            or not check_password_hash(
                admin.get("password", ""),
                password
            )
        ):
            locked_now = record_failed_login(key)

            if locked_now:
                return jsonify({
                    "success": False,
                    "message": "Too many failed attempts. Login temporarily blocked for 10 minutes."
                }), 429

            return jsonify({
                "success": False,
                "message": "Invalid admin User ID or password."
            }), 401

        clear_login_attempts(key)

        token = create_access_token(
            admin["user_id"],
            admin.get("role", "admin"),
            admin.get("name", "Administrator")
        )

        create_audit_log(
            "LOGIN",
            f"Admin login successful: {admin['user_id']}.",
            "admin",
            admin["user_id"]
        )

        return jsonify({
            "success": True,
            "message": "Admin login successful!",
            "token": token,
            "user": {
                "user_id": admin["user_id"],
                "role": admin.get("role", "admin")
            }
        }), 200

    except Exception as e:
        print("ADMIN LOGIN ERROR:", repr(e), flush=True)

        return jsonify({
            "success": False,
            "message": f"Server error occurred: {str(e)}"
        }), 500

def validate_staff_photo(photo):
    photo = str(photo or "")
    if not photo:
        return True, ""
    if len(photo) > 900000:
        return False, "Profile photo is too large. Please choose a smaller image."
    if not photo.startswith("data:image/"):
        return False, "Profile photo must be a valid image."
    return True, photo


@app.route("/admin/staff", methods=["POST"])
@admin_required
def add_staff():
    try:
        data = request.get_json() or {}
        staff_id = data.get("staff_id")
        name = data.get("name")
        email = data.get("email")
        phone = data.get("phone")
        branch = data.get("branch")
        designation = data.get("designation")
        password = data.get("password")
        photo = data.get("photo", "")

        photo_ok, photo_message = validate_staff_photo(photo)
        if not photo_ok:
            return jsonify({"success": False, "message": photo_message}), 400

        staff_id = str(staff_id or "").strip()
        name = str(name or "").strip()
        email = str(email or "").strip().lower()
        password = str(password or "")
        if not staff_id or not name or not email or not password:
            return jsonify({"success": False, "message": "Staff ID, name, email and password are required."}), 400
        if len(staff_id) > 30 or len(name) > 100 or len(email) > 150:
            return jsonify({"success": False, "message": "One or more fields are too long."}), 400
        if not valid_email(email):
            return jsonify({"success": False, "message": "Please enter a valid email address."}), 400
        if not valid_phone(phone):
            return jsonify({"success": False, "message": "Phone number must contain exactly 10 digits."}), 400
        password_ok, password_message = validate_password(password)
        if not password_ok:
            return jsonify({"success": False, "message": password_message}), 400
        if staff_collection.find_one({"staff_id": staff_id}):
            return jsonify({"success": False, "message": "Staff ID already exists."}), 409
        if staff_collection.find_one({"email": email}):
            return jsonify({"success": False, "message": "Email already exists."}), 409

        staff_collection.insert_one({
            "staff_id": staff_id,
            "name": name,
            "email": email,
            "phone": phone,
            "branch": branch,
            "designation": designation,
            "photo": photo,
            "password": generate_password_hash(password),
            "status": "active"
        })
        create_audit_log("STAFF_ADDED", f"Staff account added: {name} ({staff_id}).", target_type="staff", target_id=staff_id)
        return jsonify({"success": True, "message": "Staff added successfully!"}), 201
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to add staff.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/staff/<staff_id>", methods=["PUT"])
@admin_required
def update_staff(staff_id):
    try:
        data = request.get_json() or {}
        staff = staff_collection.find_one({"staff_id": staff_id})
        if not staff:
            return jsonify({"success": False, "message": "Staff member not found."}), 404

        required = ["name", "email"]
        if any(data.get(field) in (None, "") for field in required):
            return jsonify({"success": False, "message": "Name and email are required."}), 400

        email = data.get("email").strip()
        duplicate = staff_collection.find_one({"email": email, "staff_id": {"$ne": staff_id}})
        if duplicate:
            return jsonify({"success": False, "message": "Email already exists for another staff member."}), 409

        update = {
            "name": data.get("name").strip(),
            "email": email,
            "phone": data.get("phone", "").strip(),
            "branch": data.get("branch", "").strip(),
            "designation": data.get("designation", "").strip(),
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M")
        }

        photo = data.get("photo", staff.get("photo", ""))
        photo_ok, photo_message = validate_staff_photo(photo)
        if not photo_ok:
            return jsonify({"success": False, "message": photo_message}), 400

        update["photo"] = photo

        new_password = data.get("password")
        if new_password:
            new_password = str(new_password)
            password_ok, password_message = validate_password(new_password)
            if not password_ok:
                return jsonify({"success": False, "message": password_message}), 400
            update["password"] = generate_password_hash(new_password)

        staff_collection.update_one({"staff_id": staff_id}, {"$set": update})
        create_notification("Staff Profile Updated", f"Staff profile updated: {update['name']} ({staff_id}).", "admin")
        create_audit_log("STAFF_UPDATED", f"Staff profile updated: {update['name']} ({staff_id}).", target_type="staff", target_id=staff_id)
        return jsonify({"success": True, "message": "Staff details updated successfully."}), 200
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to update staff details.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/staff/<staff_id>", methods=["DELETE"])
@admin_required
def deactivate_staff(staff_id):
    try:
        staff = staff_collection.find_one({"staff_id": staff_id})
        if not staff:
            return jsonify({"success": False, "message": "Staff member not found."}), 404

        if staff.get("status") == "inactive":
            return jsonify({"success": False, "message": "Staff account is already inactive."}), 400

        staff_collection.update_one(
            {"staff_id": staff_id},
            {"$set": {"status": "inactive", "deactivated_at": datetime.now().strftime("%Y-%m-%d %H:%M")}}
        )
        create_notification("Staff Deactivated", f"Staff account deactivated: {staff['name']} ({staff_id}).", "admin")
        create_audit_log("STAFF_DEACTIVATED", f"Staff account deactivated: {staff['name']} ({staff_id}).", target_type="staff", target_id=staff_id)
        return jsonify({"success": True, "message": "Staff account deactivated successfully."}), 200
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to deactivate staff account.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/staff/<staff_id>/permanent", methods=["DELETE"])
@admin_required
def permanently_delete_staff(staff_id):
    try:
        staff = staff_collection.find_one({"staff_id": staff_id})
        if not staff:
            return jsonify({"success": False, "message": "Staff member not found."}), 404
        # Preserve audit history, but remove operational account and its current notifications/targets.
        targets_collection.delete_many({"staff_id": staff_id})
        notifications_collection.delete_many({"role": "staff", "user_id": staff_id})
        staff_collection.delete_one({"staff_id": staff_id})
        create_audit_log("STAFF_DELETED", f"Staff account permanently deleted: {staff.get('name', staff_id)} ({staff_id}).", target_type="staff", target_id=staff_id)
        return jsonify({"success": True, "message": "Staff account permanently deleted."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to delete staff account."}), 500


@app.route("/admin/staff", methods=["GET"])
@admin_required
def get_staff():
    try:
        staff_list = list(staff_collection.find({}, {"_id": 0, "password": 0}))
        return jsonify({"success": True, "staff": staff_list}), 200
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch staff members.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/staff/login", methods=["POST"])
def staff_login():
    try:
        data = request.get_json() or {}
        user_id = str(data.get("user_id") or "").strip()
        password = str(data.get("password") or "")
        if not user_id or not password:
            return jsonify({"success": False, "message": "Staff ID/email and password are required."}), 400
        if len(user_id) > 150 or len(password) > 128:
            return jsonify({"success": False, "message": "Invalid login input."}), 400

        key = get_login_key("staff", user_id)
        locked, minutes = is_login_locked(key)
        if locked:
            return jsonify({"success": False, "message": f"Too many failed attempts. Try again in about {minutes} minutes."}), 429

        staff = staff_collection.find_one(
            {"$or": [{"staff_id": user_id}, {"email": user_id.lower()}]},
            {
                "_id": 0, "staff_id": 1, "name": 1, "email": 1, "phone": 1,
                "branch": 1, "designation": 1, "status": 1, "photo": 1, "password": 1
            }
        )
        if not staff or staff.get("status") != "active" or not check_password_hash(staff.get("password", ""), password):
            locked_now = record_failed_login(key)
            if locked_now:
                return jsonify({"success": False, "message": "Too many failed attempts. Login temporarily blocked for 10 minutes."}), 429
            return jsonify({"success": False, "message": "Invalid staff credentials."}), 401

        clear_login_attempts(key)
        create_audit_log("LOGIN", f"Staff login successful: {staff['staff_id']}.", "staff", staff["staff_id"])
        completed_targets_count = audit_logs_collection.count_documents({"action": "TARGET_APPROVED", "metadata.staff_id": staff["staff_id"]})
        return jsonify({"success": True, "message": "Staff login successful!", "user": {
            "staff_id": staff["staff_id"], "name": staff["name"], "email": staff["email"],
            "phone": staff.get("phone", ""), "branch": staff.get("branch", ""),
            "designation": staff.get("designation", ""), "photo": staff.get("photo", ""), "status": staff.get("status", "active"), "completed_targets_count": completed_targets_count, "role": "staff"
        }, "token": create_access_token(staff["staff_id"], "staff", staff.get("name", ""))}), 200
    except Exception as e:
        return jsonify({"success": False, "message": "Server error occurred.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/targets", methods=["POST"])
@admin_required
def create_target():
    try:
        data = request.get_json() or {}
        required = ["staff_id", "category", "target_value", "start_date", "due_date"]
        if any(data.get(x) in (None, "") for x in required):
            return jsonify({"success": False, "message": "Staff, category, target value, start date and due date are required."}), 400

        staff = staff_collection.find_one({"staff_id": str(data["staff_id"]).strip()})
        if not staff or staff.get("status") != "active":
            return jsonify({"success": False, "message": "Active staff member not found."}), 404
        try:
            target_value = int(data["target_value"])
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Target value must be a whole number."}), 400
        if target_value < 1 or target_value > 1000000:
            return jsonify({"success": False, "message": "Target value must be between 1 and 1,000,000."}), 400
        if not valid_date(data["start_date"]) or not valid_date(data["due_date"]):
            return jsonify({"success": False, "message": "Start date and due date must use YYYY-MM-DD format."}), 400
        if data["due_date"] < data["start_date"]:
            return jsonify({"success": False, "message": "Due date cannot be before start date."}), 400
        if len(str(data.get("category", "")).strip()) > 80 or len(str(data.get("remarks", ""))) > 500:
            return jsonify({"success": False, "message": "Category or remarks are too long."}), 400

        target = {
            "staff_id": staff["staff_id"],
            "staff_name": staff["name"],
            "category": data["category"],
            "target_value": target_value,
            "completed_value": 0,
            "start_date": data["start_date"],
            "due_date": data["due_date"],
            "remarks": data.get("remarks", ""),
            "status": "ASSIGNED",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
        result = targets_collection.insert_one(target)
        create_notification("New Target Assigned", f"{target['category']} target assigned to you: {target['target_value']}", "staff", staff["staff_id"])
        create_notification("Target Assigned", f"Target assigned to {staff['name']} ({staff['staff_id']}).", "admin")
        email_subject = f"New Target Assigned - {target['category']}"
        email_body = (
            f"Hello {staff['name']},\n\n"
            f"A new target has been assigned to you in the Bandhan Bank Management System.\n\n"
            f"Category: {target['category']}\n"
            f"Target: {target['target_value']}\n"
            f"Start Date: {target['start_date']}\n"
            f"Due Date: {target['due_date']}\n"
            f"Remarks: {target.get('remarks') or '-'}\n\n"
            "Please login to the Staff Portal and open Notifications / My Targets to review it.\n\n"
            "Bandhan Bank Management System"
        )
        email_sent, _ = send_email(staff["email"], email_subject, email_body)
        target["_id"] = result.inserted_id
        return jsonify({"success": True, "message": "Target assigned successfully!", "email_sent": email_sent, "target": serialize_target(target)}), 201
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to create target.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/targets", methods=["GET"])
@admin_required
def get_targets():
    try:
        items = [serialize_target(t) for t in targets_collection.find({}).sort("_id", -1)]
        return jsonify({"success": True, "targets": items})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch targets.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/targets/<target_id>", methods=["PUT"])
@admin_required
def update_target(target_id):
    try:
        data = request.get_json() or {}
        target = targets_collection.find_one({"_id": ObjectId(target_id)})
        if not target:
            return jsonify({"success": False, "message": "Target not found."}), 404

        if target.get("status") not in ["ASSIGNED", "IN PROGRESS", "SEND BACK"]:
            return jsonify({"success": False, "message": "Only active targets can be edited."}), 400

        required = ["category", "target_value", "start_date", "due_date"]
        if any(data.get(x) in (None, "") for x in required):
            return jsonify({"success": False, "message": "Category, target value, start date and due date are required."}), 400

        if int(data["target_value"]) < 1:
            return jsonify({"success": False, "message": "Target value must be at least 1."}), 400

        if data["due_date"] < data["start_date"]:
            return jsonify({"success": False, "message": "Due date cannot be before start date."}), 400

        update = {
            "category": data["category"],
            "target_value": int(data["target_value"]),
            "start_date": data["start_date"],
            "due_date": data["due_date"],
            "remarks": data.get("remarks", ""),
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
        targets_collection.update_one({"_id": target["_id"]}, {"$set": update})
        create_audit_log("TARGET_UPDATED", f"Target updated: {target.get('category', 'Target')} for {target.get('staff_id', '')}.", target_type="target", target_id=target["_id"])
        return jsonify({"success": True, "message": "Target updated successfully."})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to update target.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/targets/<target_id>", methods=["DELETE"])
@admin_required
def cancel_target(target_id):
    try:
        target = targets_collection.find_one({"_id": ObjectId(target_id)})
        if not target:
            return jsonify({"success": False, "message": "Target not found."}), 404

        if target.get("status") in ["APPROVED", "SUBMITTED FOR VERIFICATION", "CANCELLED"]:
            return jsonify({"success": False, "message": "This target cannot be cancelled in its current status."}), 400

        targets_collection.update_one(
            {"_id": target["_id"]},
            {"$set": {"status": "CANCELLED", "cancelled_at": datetime.now().strftime("%Y-%m-%d %H:%M")}}
        )
        create_notification("Target Cancelled", f"Your {target['category']} target has been cancelled by admin.", "staff", target["staff_id"])
        create_notification("Target Cancelled", f"Target cancelled for {target['staff_name']} ({target['staff_id']}).", "admin")
        create_audit_log("TARGET_CANCELLED", f"Target cancelled for {target['staff_name']} ({target['staff_id']}): {target['category']}.", target_type="target", target_id=target["_id"])
        return jsonify({"success": True, "message": "Target cancelled successfully."})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to cancel target.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/staff/targets/<staff_id>", methods=["GET"])
@staff_required
def get_staff_targets(staff_id):
    try:
        if staff_id != request.current_user.get("user_id"):
            return jsonify({"success": False, "message": "Access denied."}), 403
        items = [serialize_target(t) for t in targets_collection.find({"staff_id": staff_id, "status": {"$ne": "CANCELLED"}}).sort("_id", -1)]
        return jsonify({"success": True, "targets": items})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch staff targets.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/staff/targets/<target_id>/submit", methods=["POST"])
@staff_required
def submit_target(target_id):
    try:
        data = request.get_json() or {}
        target = targets_collection.find_one({"_id": ObjectId(target_id)})
        if not target:
            return jsonify({"success": False, "message": "Target not found."}), 404
        if target.get("staff_id") != request.current_user.get("user_id"):
            return jsonify({"success": False, "message": "Access denied."}), 403
        if target.get("status") not in ["ASSIGNED", "IN PROGRESS", "SEND BACK"]:
            return jsonify({"success": False, "message": "This target cannot be submitted in its current status."}), 400

        try:
            completed = int(data.get("completed_value", 0))
        except (TypeError, ValueError):
            return jsonify({"success": False, "message": "Completed value must be a whole number."}), 400
        if completed < 0 or completed > int(target.get("target_value", 0)):
            return jsonify({"success": False, "message": "Completed value must be between 0 and the assigned target."}), 400
        completed_date = data.get("completed_date") or datetime.now().strftime("%Y-%m-%d")
        if not valid_date(completed_date):
            return jsonify({"success": False, "message": "Completion date must use YYYY-MM-DD format."}), 400
        if not data.get("acknowledgement"):
            return jsonify({"success": False, "message": "Please confirm the acknowledgement before submitting."}), 400
        if len(str(data.get("remarks", ""))) > 500:
            return jsonify({"success": False, "message": "Remarks are too long."}), 400
        update = {
            "$set": {
                "completed_value": completed,
                "submitted_date": completed_date,
                "submission_remarks": data.get("remarks", ""),
                "acknowledgement": bool(data.get("acknowledgement")),
                "status": "SUBMITTED FOR VERIFICATION"
            }
        }
        targets_collection.update_one({"_id": target["_id"]}, update)
        create_notification("Work Submitted", f"{target['staff_name']} submitted {target['category']} for verification.", "admin")
        create_notification("Submission Received", "Your work has been submitted and is waiting for admin verification.", "staff", target["staff_id"])
        create_audit_log("WORK_SUBMITTED", f"{target['staff_name']} submitted {target['category']} for verification.", target_type="target", target_id=target["_id"])
        return jsonify({"success": True, "message": "Work submitted for verification!"})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to submit target.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/verification", methods=["GET"])
@admin_required
def verification():
    try:
        items = [serialize_target(t) for t in targets_collection.find({"status": "SUBMITTED FOR VERIFICATION"}).sort("_id", -1)]
        return jsonify({"success": True, "targets": items})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch verification list.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/targets/<target_id>/verify", methods=["POST"])
@admin_required
def verify_target(target_id):
    try:
        data = request.get_json() or {}
        action = data.get("action")
        target = targets_collection.find_one({"_id": ObjectId(target_id)})
        if not target:
            return jsonify({"success": False, "message": "Target not found."}), 404
        if target.get("status") != "SUBMITTED FOR VERIFICATION":
            return jsonify({"success": False, "message": "Only submitted targets can be verified."}), 400

        if action == "approve":
            new_status = "APPROVED"
            title = "Target Approved"
            message = f"Your {target['category']} target has been approved by admin."
        elif action == "send_back":
            new_status = "SEND BACK"
            title = "Target Sent Back"
            message = data.get("remarks") or "Admin requested an update to your submitted work."
        else:
            return jsonify({"success": False, "message": "Invalid verification action."}), 400

        if action == "approve":
            create_notification(title, message, "staff", target["staff_id"])
            create_audit_log("TARGET_APPROVED", f"Admin approved target {target['category']} for {target['staff_name']} ({target['staff_id']}).", target_type="target", target_id=target["_id"], metadata={"remarks": data.get("remarks", ""), "staff_id": target.get("staff_id", ""), "category": target.get("category", ""), "target_value": target.get("target_value", 0), "completed_value": target.get("completed_value", 0), "due_date": target.get("due_date", "")})
            targets_collection.delete_one({"_id": target["_id"]})
            return jsonify({"success": True, "message": "Target approved and cleared from active records."})

        targets_collection.update_one({"_id": target["_id"]}, {"$set": {"status": new_status, "admin_remarks": data.get("remarks", ""), "verified_at": datetime.now().strftime("%Y-%m-%d %H:%M")}})
        create_notification(title, message, "staff", target["staff_id"])
        create_audit_log("TARGET_SENT_BACK", f"Admin sent back target {target['category']} for {target['staff_name']} ({target['staff_id']}).", target_type="target", target_id=target["_id"], metadata={"remarks": data.get("remarks", "")})
        return jsonify({"success": True, "message": "Target sent back to staff."})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to verify target.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/notifications", methods=["GET"])
def notifications():
    try:
        role = request.args.get("role", "")
        user_id = request.args.get("user_id")
        payload, error = verify_token(role if role in ["admin", "staff"] else None)
        if error:
            return error
        if role not in ["admin", "staff"]:
            return jsonify({"success": False, "message": "Valid role is required."}), 400
        if role == "staff":
            if user_id and user_id != payload.get("user_id"):
                return jsonify({"success": False, "message": "Access denied."}), 403
            user_id = payload.get("user_id")
        query = {"role": role}
        if user_id:
            query["user_id"] = user_id
        items = list(notifications_collection.find(query).sort("_id", -1).limit(50))
        for item in items:
            item["_id"] = str(item["_id"])
        unread_query = dict(query)
        unread_query["read"] = {"$ne": True}
        unread_count = notifications_collection.count_documents(unread_query)
        return jsonify({"success": True, "notifications": items, "unread_count": unread_count})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch notifications.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/staff/forgot-password", methods=["POST"])
def staff_forgot_password():
    try:
        data = request.get_json() or {}
        email = str(data.get("email") or "").strip().lower()
        if not valid_email(email):
            return jsonify({"success": False, "message": "Please enter a valid staff email address."}), 400

        staff = staff_collection.find_one({"email": email}, {"_id": 0, "staff_id": 1, "name": 1, "email": 1, "status": 1})
        # Do not reveal whether an email is registered.
        generic = "If this email belongs to an active staff account, an OTP has been sent."
        if not staff or staff.get("status") != "active":
            return jsonify({"success": True, "message": generic}), 200

        otp = f"{secrets.randbelow(1000000):06d}"
        expires_at = datetime.utcnow() + timedelta(minutes=OTP_EXPIRES_MINUTES)
        password_resets_collection.delete_many({"staff_id": staff["staff_id"]})
        password_resets_collection.insert_one({
            "staff_id": staff["staff_id"],
            "email": email,
            "otp_hash": hash_otp(otp),
            "attempts": 0,
            "expires_at": expires_at,
            "created_at": datetime.utcnow()
        })
        subject = "Bandhan Bank - Password Reset OTP"
        body = (f"Hello {staff.get('name', 'Staff')},\\n\\n"
                f"Your password reset OTP is: {otp}\\n\\n"
                f"This OTP expires in {OTP_EXPIRES_MINUTES} minutes.\\n"
                "Do not share this OTP with anyone.\\n\\n"
                "Bandhan Bank Management System")
        sent, _ = send_email(email, subject, body)
        if not sent:
            password_resets_collection.delete_many({"staff_id": staff["staff_id"]})
            return jsonify({"success": False, "message": "Password reset email is not configured. Please contact the administrator."}), 503
        create_audit_log("PASSWORD_RESET_OTP_SENT", f"Password reset OTP sent for staff {staff['staff_id']}.", "staff", staff["staff_id"], "staff", staff["staff_id"])
        return jsonify({"success": True, "message": generic}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to start password reset."}), 500


@app.route("/staff/verify-reset-otp", methods=["POST"])
def verify_reset_otp():
    try:
        data = request.get_json() or {}
        email = str(data.get("email") or "").strip().lower()
        otp = str(data.get("otp") or "").strip()
        if not valid_email(email) or not re.fullmatch(r"\d{6}", otp):
            return jsonify({"success": False, "message": "Enter the 6-digit OTP sent to your email."}), 400
        record = password_resets_collection.find_one({"email": email})
        if not record or record.get("expires_at") <= datetime.utcnow():
            return jsonify({"success": False, "message": "OTP is invalid or expired. Please request a new OTP."}), 400
        if int(record.get("attempts", 0)) >= OTP_MAX_ATTEMPTS:
            password_resets_collection.delete_one({"_id": record["_id"]})
            return jsonify({"success": False, "message": "Too many OTP attempts. Please request a new OTP."}), 429
        if not secrets.compare_digest(record.get("otp_hash", ""), hash_otp(otp)):
            password_resets_collection.update_one({"_id": record["_id"]}, {"$inc": {"attempts": 1}})
            return jsonify({"success": False, "message": "Incorrect OTP."}), 400
        password_resets_collection.update_one({"_id": record["_id"]}, {"$set": {"verified": True, "verified_at": datetime.utcnow()}})
        return jsonify({"success": True, "message": "OTP verified. You can now set a new password."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to verify OTP."}), 500


@app.route("/staff/reset-password", methods=["POST"])
def staff_reset_password():
    try:
        data = request.get_json() or {}
        email = str(data.get("email") or "").strip().lower()
        new_password = str(data.get("new_password") or "")
        if not valid_email(email):
            return jsonify({"success": False, "message": "Please enter a valid email address."}), 400
        password_ok, password_message = validate_password(new_password)
        if not password_ok:
            return jsonify({"success": False, "message": password_message}), 400
        record = password_resets_collection.find_one({"email": email, "verified": True})
        if not record or record.get("expires_at") <= datetime.utcnow():
            return jsonify({"success": False, "message": "Password reset session expired. Please request a new OTP."}), 400
        staff = staff_collection.find_one({"staff_id": record["staff_id"], "email": email, "status": "active"})
        if not staff:
            return jsonify({"success": False, "message": "Active staff account not found."}), 404
        staff_collection.update_one({"_id": staff["_id"]}, {"$set": {"password": generate_password_hash(new_password), "password_updated_at": datetime.now().strftime("%Y-%m-%d %H:%M")}})
        password_resets_collection.delete_one({"_id": record["_id"]})
        create_audit_log("PASSWORD_RESET", f"Staff password reset successfully for {staff['staff_id']}.", "staff", staff["staff_id"], "staff", staff["staff_id"])
        return jsonify({"success": True, "message": "Password changed successfully. Please login with your new password."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to reset password."}), 500


@app.route("/notifications/read", methods=["POST"])
def mark_notification_read():
    try:
        payload, error = verify_token()
        if error:
            return error
        data = request.get_json() or {}
        notification_id = str(data.get("notification_id") or "")
        if not ObjectId.is_valid(notification_id):
            return jsonify({"success": False, "message": "Invalid notification."}), 400
        query = {"_id": ObjectId(notification_id), "role": payload.get("role")}
        if payload.get("role") == "staff":
            query["user_id"] = payload.get("user_id")
        result = notifications_collection.update_one(query, {"$set": {"read": True, "read_at": datetime.now().strftime("%Y-%m-%d %H:%M")}})
        if result.matched_count == 0:
            return jsonify({"success": False, "message": "Notification not found."}), 404
        return jsonify({"success": True, "message": "Notification marked as read."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to update notification."}), 500


@app.route("/notifications/<notification_id>", methods=["DELETE"])
def delete_notification(notification_id):
    try:
        payload, error = verify_token()
        if error:
            return error
        if not ObjectId.is_valid(notification_id):
            return jsonify({"success": False, "message": "Invalid notification."}), 400
        query = {"_id": ObjectId(notification_id), "role": payload.get("role")}
        if payload.get("role") == "staff":
            query["user_id"] = payload.get("user_id")
        result = notifications_collection.delete_one(query)
        if result.deleted_count == 0:
            return jsonify({"success": False, "message": "Notification not found."}), 404
        return jsonify({"success": True, "message": "Notification deleted."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to delete notification."}), 500


@app.route("/notifications/cleanup", methods=["POST"])
def cleanup_notifications():
    try:
        payload, error = verify_token()
        if error:
            return error
        query = {"role": payload.get("role"), "read": True}
        if payload.get("role") == "staff":
            query["user_id"] = payload.get("user_id")
        result = notifications_collection.delete_many(query)
        return jsonify({"success": True, "deleted_count": result.deleted_count, "message": "Read notifications cleaned up."}), 200
    except Exception:
        return jsonify({"success": False, "message": "Unable to clean notifications."}), 500


@app.route("/admin/audit-logs", methods=["GET"])
@admin_required
def audit_logs():
    try:
        limit = min(max(int(request.args.get("limit", 100)), 1), 200)
        logs = list(audit_logs_collection.find({}).sort("_id", -1).limit(limit))
        for log in logs:
            log["_id"] = str(log["_id"])
        return jsonify({"success": True, "logs": logs})
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to fetch audit logs.", "request_id": getattr(request, "request_id", None)}), 500


@app.route("/admin/reports", methods=["GET"])
@admin_required
def reports():
    try:
        total_staff = staff_collection.count_documents({"status": "active"})
        active_target_count = targets_collection.count_documents({"status": {"$ne": "CANCELLED"}})
        completed = audit_logs_collection.count_documents({"action": "TARGET_APPROVED"})
        total_targets = active_target_count + completed
        pending_verification = targets_collection.count_documents({"status": "SUBMITTED FOR VERIFICATION"})
        category_map = defaultdict(lambda: {"total": 0, "completed": 0, "in_progress": 0})
        in_progress = 0
        overdue = 0
        for item in targets_collection.find({"status": {"$ne": "CANCELLED"}}, {"category": 1, "status": 1}):
            category = item.get("category", "Other")
            category_map[category]["total"] += 1
            if item.get("status") in ["ASSIGNED", "IN PROGRESS", "SEND BACK"]:
                category_map[category]["in_progress"] += 1
                in_progress += 1
        for item in audit_logs_collection.find({"action": "TARGET_APPROVED"}, {"metadata": 1}):
            metadata = item.get("metadata") or {}
            category = metadata.get("category", "Other")
            category_map[category]["total"] += 1
            category_map[category]["completed"] += 1
        categories = [{"category": category, **values} for category, values in sorted(category_map.items())]

        today = datetime.now().strftime("%Y-%m-%d")
        overdue = targets_collection.count_documents({
            "due_date": {"$lt": today},
            "status": {"$nin": ["APPROVED", "CANCELLED"]}
        })

        recent = list(targets_collection.find({"status": {"$ne": "CANCELLED"}}).sort("_id", -1).limit(5))
        recent_activity = []
        for item in recent:
            recent_activity.append({
                "id": str(item.get("_id")),
                "staff_name": item.get("staff_name", item.get("staff_id", "Staff")),
                "staff_id": item.get("staff_id", "-"),
                "category": item.get("category", "-"),
                "status": item.get("status", "-"),
                "date": item.get("submitted_date") or item.get("due_date") or item.get("start_date") or "-"
            })

        completion_percent = round((completed / total_targets) * 100) if total_targets else 0
        return jsonify({
            "success": True,
            "total_staff": total_staff,
            "total_targets": total_targets,
            "completed": completed,
            "pending_verification": pending_verification,
            "in_progress": in_progress,
            "overdue": overdue,
            "completion_percent": completion_percent,
            "categories": categories,
            "recent_activity": recent_activity
        })
    except Exception as e:
        return jsonify({"success": False, "message": "Unable to generate reports.", "request_id": getattr(request, "request_id", None)}), 500


if __name__ == "__main__":
    app.run(debug=False)
