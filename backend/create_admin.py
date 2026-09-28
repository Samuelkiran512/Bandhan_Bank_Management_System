from pymongo import MongoClient
from werkzeug.security import generate_password_hash


# =========================
# MONGODB CONNECTION
# =========================

client = MongoClient("mongodb://127.0.0.1:27017/")

db = client["bandhan_bank_management"]

admins_collection = db["admins"]


# =========================
# ADMIN DETAILS
# =========================

admin_user_id = "admin@bandhanbank.com"
admin_password = "Shyam@123"


# =========================
# CHECK EXISTING ADMIN
# =========================

existing_admin = admins_collection.find_one({
    "user_id": admin_user_id
})


if existing_admin:
    print("Admin account already exists.")

else:

    hashed_password = generate_password_hash(admin_password)

    admin_data = {
        "user_id": admin_user_id,
        "password": hashed_password,
        "role": "admin",
        "status": "active"
    }

    admins_collection.insert_one(admin_data)

    print("Admin account created successfully!")
    print("User ID:", admin_user_id)
    print("Password: Shyam@123")


# =========================
# CLOSE CONNECTION
# =========================

client.close()