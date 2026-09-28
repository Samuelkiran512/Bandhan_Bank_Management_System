from pymongo import MongoClient
from werkzeug.security import generate_password_hash

client = MongoClient("mongodb://127.0.0.1:27017/")
db = client["bandhan_bank_management"]

result = db.staff.update_one(
    {"staff_id": "BB1025"},
    {"$set": {"password": generate_password_hash("Kumar@123")}}
)

if result.modified_count == 1:
    print("Password reset successfully")
elif result.matched_count == 1:
    print("Staff found, password already same")
else:
    print("Staff BB1025 not found")