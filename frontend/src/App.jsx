import { useEffect, useRef, useState } from "react";
import "./App.css";
import "./App_addon.css";
import "./App_theme.css";

function App() {
  const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:5000";
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("bandhan-theme") || "dark"; } catch { return "dark"; }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("bandhan-theme", theme); } catch {}
  }, [theme]);

  useEffect(() => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bandhan-theme-toggle ${theme === "light" ? "is-light" : ""}`;
    button.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.innerHTML = `<span class="theme-toggle-icon">${theme === "dark" ? "☀️" : "🌙"}</span><span>${theme === "dark" ? "Light Mode" : "Dark Mode"}</span>`;
    const handleClick = () => setTheme((current) => current === "dark" ? "light" : "dark");
    button.addEventListener("click", handleClick);
    document.body.appendChild(button);
    return () => { button.removeEventListener("click", handleClick); button.remove(); };
  }, [theme]);

  const clearAuthSession = (message = "") => {
    try {
      localStorage.removeItem("bandhan_access_token");
      localStorage.removeItem("bandhan_user_role");
      localStorage.removeItem("bandhan_user");
    } catch {
      // Ignore storage errors.
    }
    setStaffUser(null);
    setStaffPage(false);
    setSelectedStaffProfile(null);
    setSelectedStaffTarget(null);
    setAdminUserId("");
    setAdminPassword("");
    setStaffLoginId("");
    setStaffLoginPassword("");
    setLoginMessage(message);
    setStaffLoginMessage("");
    setCurrentPage("home");
  };

  const [currentPage, setCurrentPage] = useState("home");
  const [staffPage, setStaffPage] = useState(false);
  const [showAddStaffForm, setShowAddStaffForm] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [staffPhotoData, setStaffPhotoData] = useState("");
  const [selectedStaffProfile, setSelectedStaffProfile] = useState(null);
  // =========================================================
  // AUTHENTICATED API REQUEST HELPER
  // =========================================================
  const apiFetch = async (url, options = {}) => {
    const token = localStorage.getItem("bandhan_access_token");
    const headers = { ...(options.headers || {}) };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && !url.endsWith("/admin/login") && !url.endsWith("/staff/login")) {
      window.dispatchEvent(new Event("bandhan-auth-expired"));
    }
    return response;
  };

  const loadStaff = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/admin/staff`);
      const data = await response.json();
      if (data.success) setStaffList(data.staff);
    } catch (error) {
      console.error("Error fetching staff:", error);
    }
  };

  useEffect(() => {
    if (staffPage) loadStaff();
  }, [staffPage]);

  const prepareStaffPhoto = (file) => {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve("");
        return;
      }
      if (!file.type.startsWith("image/")) {
        reject(new Error("Please select an image file."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          const maxSize = 640;
          const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        };
        image.onerror = () => reject(new Error("Unable to read the selected image."));
        image.src = reader.result;
      };
      reader.onerror = () => reject(new Error("Unable to read the selected image."));
      reader.readAsDataURL(file);
    });
  };

  const handleStaffPhotoChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const photo = await prepareStaffPhoto(file);
      setStaffPhotoData(photo);
    } catch (error) {
      setStaffPhotoData("");
      alert(error.message || "Unable to process the photo.");
      event.target.value = "";
    }
  };
  const handleAddStaff = async (event) => {
  event.preventDefault();

  const formData = new FormData(event.target);

  const staffData = {
    staff_id: formData.get("staff_id"),
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    branch: formData.get("branch"),
    designation: formData.get("designation"),
    password: formData.get("password"),
    photo: staffPhotoData,
  };

  try {
    const response = await apiFetch(`${API_BASE}/admin/staff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(staffData),
    });

    const data = await response.json();

    if (response.ok) {
      alert("Staff account created successfully!");

      event.target.reset();
      setStaffPhotoData("");
      setShowAddStaffForm(false);
      await loadStaff();
    } else {
      alert(data.message || "Unable to create staff account.");
    }
  } catch (error) {
    console.error("Add staff error:", error);
    alert("Backend server is not connected.");
  }
};
  const handleEditStaff = async (event) => {
    event.preventDefault();
    if (!editingStaff) return;

    const formData = new FormData(event.target);
    const staffData = {
      name: formData.get("name"),
      email: formData.get("email"),
      phone: formData.get("phone"),
      branch: formData.get("branch"),
      designation: formData.get("designation"),
      password: formData.get("password"),
      photo: staffPhotoData || editingStaff.photo || "",
    };

    try {
      const response = await apiFetch(`${API_BASE}/admin/staff/${encodeURIComponent(editingStaff.staff_id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(staffData),
      });
      const data = await response.json();
      if (response.ok) {
        alert("Staff details updated successfully!");
        setEditingStaff(null);
        setStaffPhotoData("");
        await loadStaff();
      } else {
        alert(data.message || "Unable to update staff details.");
      }
    } catch (error) {
      console.error("Edit staff error:", error);
      alert("Backend server is not connected.");
    }
  };

  const handleDeactivateStaff = async (staff) => {
    if (staff.status !== "active") {
      alert("This staff account is already inactive.");
      return;
    }

    const confirmed = window.confirm(`Deactivate ${staff.name} (${staff.staff_id})?\n\nThey will no longer be able to log in, but their records and targets will remain available for record keeping.`);
    if (!confirmed) return;

    try {
      const response = await apiFetch(`${API_BASE}/admin/staff/${encodeURIComponent(staff.staff_id)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (response.ok) {
        alert("Staff account deactivated successfully!");
        await loadStaff();
      } else {
        alert(data.message || "Unable to deactivate staff account.");
      }
    } catch (error) {
      console.error("Deactivate staff error:", error);
      alert("Backend server is not connected.");
    }
  };

  const handlePermanentDeleteStaff = async (staff) => {
    if (staff.status !== "inactive") {
      alert("For safety, only inactive staff accounts can be permanently deleted.");
      return;
    }
    const confirmed = window.confirm(`Permanently delete ${staff.name} (${staff.staff_id})?\n\nThis removes the staff account, its current targets and staff notifications. Audit history is preserved.`);
    if (!confirmed) return;
    try {
      const response = await apiFetch(`${API_BASE}/admin/staff/${encodeURIComponent(staff.staff_id)}/permanent`, { method: "DELETE" });
      const data = await response.json();
      if (response.ok) {
        alert("Staff account permanently deleted.");
        await loadStaff();
      } else {
        alert(data.message || "Unable to delete staff account.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const [showPassword, setShowPassword] = useState(false);
  const [adminUserId, setAdminUserId] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [loginMessage, setLoginMessage] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // =========================================================
  // BANK MANAGEMENT FEATURES
  // =========================================================
  const [targets, setTargets] = useState([]);
  const [verificationList, setVerificationList] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [reportData, setReportData] = useState(null);
  const [staffUser, setStaffUser] = useState(null);
  const [staffLoginId, setStaffLoginId] = useState("");
  const [staffLoginPassword, setStaffLoginPassword] = useState("");
  const [showStaffPassword, setShowStaffPassword] = useState(false);
  const [staffLoginMessage, setStaffLoginMessage] = useState("");
  const [isStaffLoggingIn, setIsStaffLoggingIn] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotOtp, setForgotOtp] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState("");
  const [forgotStep, setForgotStep] = useState("email");
  const [forgotMessage, setForgotMessage] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [selectedStaffTarget, setSelectedStaffTarget] = useState(null);
  const [featureMessage, setFeatureMessage] = useState("");
  const [editingTarget, setEditingTarget] = useState(null);
  const staffLoginIdRef = useRef(null);

  // Restore the authenticated session after a browser refresh.
  useEffect(() => {
    const restoreSession = () => {
      try {
        const token = localStorage.getItem("bandhan_access_token");
        const role = localStorage.getItem("bandhan_user_role");
        const storedUser = localStorage.getItem("bandhan_user");
        if (!token || !role) return;

        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          clearAuthSession("Your session has expired. Please login again.");
          return;
        }

        if (role === "staff" && storedUser) {
          const user = JSON.parse(storedUser);
          setStaffUser(user);
          setCurrentPage("staff-dashboard");
        } else if (role === "admin") {
          setCurrentPage("admin-dashboard");
        }
      } catch {
        clearAuthSession("Invalid session. Please login again.");
      }
    };

    restoreSession();

    const handleExpired = () => {
      clearAuthSession("Your session has expired. Please login again.");
    };
    window.addEventListener("bandhan-auth-expired", handleExpired);
    return () => window.removeEventListener("bandhan-auth-expired", handleExpired);
  }, []);

  // Automatically return to the login page when the JWT expires.
  useEffect(() => {
    const checkTokenExpiry = () => {
      const token = localStorage.getItem("bandhan_access_token");
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          clearAuthSession("Your session has expired. Please login again.");
        }
      } catch {
        clearAuthSession("Invalid session. Please login again.");
      }
    };
    const timer = setInterval(checkTokenExpiry, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (currentPage === "staff-login") {
      const timer = setTimeout(() => {
        staffLoginIdRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [currentPage]);

  const loadTargets = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/admin/targets`);
      const data = await response.json();
      if (data.success) setTargets(data.targets);
    } catch (error) {
      console.error("Target loading error:", error);
    }
  };

  const loadVerification = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/admin/verification`);
      const data = await response.json();
      if (data.success) setVerificationList(data.targets);
    } catch (error) {
      console.error("Verification loading error:", error);
    }
  };

  const loadNotifications = async (role, userId = "") => {
    try {
      const url = userId
        ? `${API_BASE}/notifications?role=${role}&user_id=${encodeURIComponent(userId)}`
        : `${API_BASE}/notifications?role=${role}`;
      const response = await apiFetch(url);
      const data = await response.json();
      if (data.success) setNotifications(data.notifications);
    } catch (error) {
      console.error("Notification loading error:", error);
    }
  };

  const loadReports = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/admin/reports`);
      const data = await response.json();
      if (data.success) setReportData(data);
    } catch (error) {
      console.error("Report loading error:", error);
    }
  };

  useEffect(() => {
    if (currentPage === "admin-dashboard") {
      loadReports();
      loadTargets();
    }
    if (currentPage === "target-management") {
      apiFetch(`${API_BASE}/admin/staff`).then((r) => r.json()).then((d) => { if (d.success) setStaffList(d.staff); }).catch(() => {});
    }
    if (currentPage === "staff-dashboard" || currentPage === "staff-targets" || currentPage === "staff-progress") {
      if (staffUser?.staff_id) {
        apiFetch(`${API_BASE}/staff/targets/${encodeURIComponent(staffUser.staff_id)}`).then((r) => r.json()).then((d) => { if (d.success) setTargets(d.targets); }).catch(() => {});
      }
    }
  }, [currentPage, staffUser]);

  const handleStaffLogin = async () => {
    setStaffLoginMessage("");
    if (!staffLoginId || !staffLoginPassword) {
      setStaffLoginMessage("Please enter Staff ID/email and password.");
      return;
    }
    setIsStaffLoggingIn(true);
    try {
      const response = await apiFetch(`${API_BASE}/staff/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: staffLoginId, password: staffLoginPassword }),
      });
      const data = await response.json();
      if (data.success) {
        localStorage.setItem("bandhan_access_token", data.token);
        localStorage.setItem("bandhan_user_role", "staff");
        localStorage.setItem("bandhan_user", JSON.stringify(data.user));
        setStaffUser(data.user);
        setStaffLoginMessage("Login successful!");
        setCurrentPage("staff-dashboard");
        loadNotifications("staff", data.user.staff_id);
      } else {
        setStaffLoginMessage(data.message || "Invalid staff credentials.");
      }
    } catch (error) {
      setStaffLoginMessage("Unable to connect to backend server.");
    } finally {
      setIsStaffLoggingIn(false);
    }
  };

  const handleForgotPasswordRequest = async () => {
    setForgotMessage("");
    const email = forgotEmail.trim().toLowerCase();
    if (!email) {
      setForgotMessage("Please enter your registered staff email.");
      return;
    }
    setForgotLoading(true);
    try {
      const response = await fetch(`${API_BASE}/staff/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (response.ok) {
        setForgotStep("otp");
        setForgotMessage(data.message || "If the account exists, an OTP has been sent to your email.");
      } else {
        setForgotMessage(data.message || "Unable to send OTP.");
      }
    } catch (error) {
      setForgotMessage("Unable to connect to backend server.");
    } finally {
      setForgotLoading(false);
    }
  };

  const handleVerifyForgotOtp = async () => {
    setForgotMessage("");
    if (!/^\d{6}$/.test(forgotOtp.trim())) {
      setForgotMessage("Please enter the 6-digit OTP from your email.");
      return;
    }
    setForgotLoading(true);
    try {
      const response = await fetch(`${API_BASE}/staff/verify-reset-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim().toLowerCase(), otp: forgotOtp.trim() }),
      });
      const data = await response.json();
      if (response.ok) {
        setForgotStep("password");
        setForgotMessage(data.message || "OTP verified. Set your new password.");
      } else {
        setForgotMessage(data.message || "Invalid OTP.");
      }
    } catch (error) {
      setForgotMessage("Unable to connect to backend server.");
    } finally {
      setForgotLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setForgotMessage("");
    if (!forgotNewPassword || forgotNewPassword !== forgotConfirmPassword) {
      setForgotMessage("Passwords do not match.");
      return;
    }
    setForgotLoading(true);
    try {
      const response = await fetch(`${API_BASE}/staff/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail.trim().toLowerCase(), new_password: forgotNewPassword }),
      });
      const data = await response.json();
      if (response.ok) {
        setForgotMessage(data.message || "Password changed successfully.");
        setForgotEmail("");
        setForgotOtp("");
        setForgotNewPassword("");
        setForgotConfirmPassword("");
        setForgotStep("email");
        setTimeout(() => setCurrentPage("staff-login"), 900);
      } else {
        setForgotMessage(data.message || "Unable to reset password.");
      }
    } catch (error) {
      setForgotMessage("Unable to connect to backend server.");
    } finally {
      setForgotLoading(false);
    }
  };

  const handleMarkNotificationRead = async (notificationId) => {
    try {
      const response = await apiFetch(`${API_BASE}/notifications/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notification_id: notificationId }),
      });
      if (response.ok) {
        setNotifications((items) => items.map((item) => item._id === notificationId ? { ...item, read: true } : item));
      }
    } catch (error) {
      console.error("Notification read error:", error);
    }
  };

  const handleDeleteNotification = async (notificationId) => {
    try {
      const response = await apiFetch(`${API_BASE}/notifications/${encodeURIComponent(notificationId)}`, { method: "DELETE" });
      if (response.ok) setNotifications((items) => items.filter((item) => item._id !== notificationId));
    } catch (error) {
      console.error("Notification delete error:", error);
    }
  };

  const handleCleanupReadNotifications = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/notifications/cleanup`, { method: "POST" });
      const data = await response.json();
      if (response.ok) {
        setNotifications((items) => items.filter((item) => !item.read));
        alert(`${data.deleted_count || 0} read notifications cleaned up.`);
      } else {
        alert(data.message || "Unable to clean notifications.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleUpdateTarget = async (event) => {
    event.preventDefault();
    if (!editingTarget) return;
    const formData = new FormData(event.target);
    const payload = {
      category: formData.get("category"),
      target_value: Number(formData.get("target_value")),
      start_date: formData.get("start_date"),
      due_date: formData.get("due_date"),
      remarks: formData.get("remarks"),
    };
    try {
      const response = await apiFetch(`${API_BASE}/admin/targets/${editingTarget._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        alert("Target updated successfully!");
        setEditingTarget(null);
        loadTargets();
      } else {
        alert(data.message || "Unable to update target.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleCancelTarget = async (targetId) => {
    if (!window.confirm("Cancel this target? It will no longer be available to the staff member.")) return;
    try {
      const response = await apiFetch(`${API_BASE}/admin/targets/${targetId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (response.ok) {
        alert("Target cancelled successfully!");
        loadTargets();
      } else {
        alert(data.message || "Unable to cancel target.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleAssignTarget = async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const payload = {
      staff_id: formData.get("staff_id"),
      category: formData.get("category"),
      target_value: Number(formData.get("target_value")),
      start_date: formData.get("start_date"),
      due_date: formData.get("due_date"),
      remarks: formData.get("remarks"),
    };
    try {
      const response = await apiFetch(`${API_BASE}/admin/targets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        alert(data.email_sent ? "Target assigned successfully and email notification sent to the staff member." : "Target assigned successfully. In-app notification was created, but email could not be sent.");
        event.target.reset();
        loadTargets();
      } else {
        alert(data.message || "Unable to assign target.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleVerifyTarget = async (targetId, action) => {
    const remarks = action === "send_back" ? "Please update the submitted work." : "";
    try {
      const response = await apiFetch(`${API_BASE}/admin/targets/${targetId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, remarks }),
      });
      const data = await response.json();
      if (response.ok) {
        setFeatureMessage(data.message);
        loadVerification();
        loadTargets();
      } else {
        alert(data.message || "Unable to update verification.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleSubmitTarget = async (event) => {
    event.preventDefault();
    if (!selectedStaffTarget || !staffUser) return;
    const formData = new FormData(event.target);
    const payload = {
      completed_value: Number(formData.get("completed_value")),
      completed_date: formData.get("completed_date"),
      remarks: formData.get("remarks"),
      acknowledgement: formData.get("acknowledgement") === "on",
    };
    try {
      const response = await apiFetch(`${API_BASE}/staff/targets/${selectedStaffTarget._id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok) {
        alert("Work submitted for verification!");
        setSelectedStaffTarget(null);
        setCurrentPage("staff-targets");
      } else {
        alert(data.message || "Unable to submit work.");
      }
    } catch (error) {
      alert("Backend server is not connected.");
    }
  };

  const handleLogout = async (redirectMessage = "") => {
    try {
      const token = localStorage.getItem("bandhan_access_token");
      if (token) {
        await fetch(`${API_BASE}/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Local cleanup still happens when the backend is unavailable.
    } finally {
      clearAuthSession(redirectMessage);
    }
  };

  // =========================================================
  // ADMIN LOGIN
  // =========================================================

  const handleAdminLogin = async () => {
    setLoginMessage("");

    if (!adminUserId || !adminPassword) {
      setLoginMessage("Please enter User ID and password.");
      return;
    }

    setIsLoggingIn(true);

    try {
      const response = await apiFetch(
        `${API_BASE}/admin/login`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            user_id: adminUserId,
            password: adminPassword,
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        localStorage.setItem("bandhan_access_token", data.token);
        localStorage.setItem("bandhan_user_role", "admin");
        localStorage.setItem("bandhan_user", JSON.stringify(data.user || { user_id: adminUserId, role: "admin" }));
        setLoginMessage("Login successful!");

        setTimeout(() => {
          setCurrentPage("admin-dashboard");
        }, 500);
      } else {
        setLoginMessage(data.message);
      }
    } catch (error) {
      setLoginMessage(
        "Unable to connect to backend server."
      );
    } finally {
      setIsLoggingIn(false);
    }
  };
// =========================================================
// =========================================================
// ROUTE GUARD
// =========================================================

const protectedAdminPages = new Set(["admin-dashboard", "target-management", "verification", "reports", "admin-notifications", "settings"]);
const protectedStaffPages = new Set(["staff-dashboard", "staff-targets", "staff-progress", "staff-notifications", "staff-profile", "submit-target"]);
const currentRole = localStorage.getItem("bandhan_user_role");
if (protectedAdminPages.has(currentPage) && currentRole !== "admin") {
  return <div className="app"><main className="login-page"><div className="login-card"><h1>Session Required</h1><p className="login-description">Please login to access the administrator portal.</p><button className="login-button admin-login-button" onClick={() => setCurrentPage("admin-login")}>Go to Admin Login</button></div></main></div>;
}
if (protectedStaffPages.has(currentPage) && currentRole !== "staff") {
  return <div className="app"><main className="login-page"><div className="login-card"><h1>Session Required</h1><p className="login-description">Please login to access the staff portal.</p><button className="login-button admin-login-button" onClick={() => setCurrentPage("staff-login")}>Go to Staff Login</button></div></main></div>;
}

// =========================================================
// STAFF MANAGEMENT PAGE
// =========================================================

if (staffPage) {

  // ---------------- EDIT STAFF FORM ----------------

  if (editingStaff) {
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header">
          <div>
            <h1>Edit Staff Member</h1>
            <p>Update the staff member's account details.</p>
          </div>
          <button className="back-dashboard-btn" onClick={() => { setStaffPhotoData(""); setEditingStaff(null); }}>
            ← Back to Staff Management
          </button>
        </div>

        <div className="staff-management-card">
          <div className="staff-management-top">
            <div>
              <h2>Staff Information</h2>
              <p>Staff ID cannot be changed after account creation.</p>
            </div>
          </div>

          <form className="staff-form" onSubmit={handleEditStaff}>
            <div className="form-row">
              <div className="form-group">
                <label>Staff ID</label>
                <input type="text" value={editingStaff.staff_id} readOnly />
              </div>
              <div className="form-group">
                <label>Full Name</label>
                <input type="text" name="name" defaultValue={editingStaff.name || ""} required />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Email</label>
                <input type="email" name="email" defaultValue={editingStaff.email || ""} required />
              </div>
              <div className="form-group">
                <label>Phone Number</label>
                <input type="tel" name="phone" defaultValue={editingStaff.phone || ""} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Branch</label>
                <input type="text" name="branch" defaultValue={editingStaff.branch || ""} />
              </div>
              <div className="form-group">
                <label>Designation</label>
                <input type="text" name="designation" defaultValue={editingStaff.designation || ""} />
              </div>
            </div>

            <div className="form-row staff-photo-form-row">
              <div className="form-group staff-photo-field">
                <label>Profile Photo</label>
                <input type="file" accept="image/*" onChange={handleStaffPhotoChange} />
                <small>Choose a new photo or leave it unchanged.</small>
                {(staffPhotoData || editingStaff.photo) && (
                  <img className="staff-photo-preview" src={staffPhotoData || editingStaff.photo} alt="Staff preview" />
                )}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>New Password (optional)</label>
                <input type="password" name="password" placeholder="Leave blank to keep current password" />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="back-dashboard-btn" onClick={() => { setStaffPhotoData(""); setEditingStaff(null); }}>Cancel</button>
              <button type="submit" className="add-staff-btn">Save Changes</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ---------------- ADD STAFF FORM ----------------

  if (showAddStaffForm) {
    return (
      <div className="admin-dashboard">

        <div className="dashboard-header">

          <div>
            <h1>Add Staff Member</h1>
            <p>Create a new bank staff account.</p>
          </div>

          <button
            className="back-dashboard-btn"
            onClick={() => { setStaffPhotoData(""); setShowAddStaffForm(false); }}
          >
            ← Back to Staff Management
          </button>

        </div>

        <div className="staff-management-card">

          <div className="staff-management-top">

            <div>
              <h2>Staff Information</h2>
              <p>
                Enter the staff member's details below.
              </p>
            </div>

          </div>

          <form
            className="staff-form"
            onSubmit={handleAddStaff}
          >

            {/* STAFF ID + NAME */}

            <div className="form-row">

              <div className="form-group">

                <label>Staff ID</label>

                <input
                  type="text"
                  name="staff_id"
                  placeholder="Example: BB1025"
                  required
                />

              </div>


              <div className="form-group">

                <label>Full Name</label>

                <input
                  type="text"
                  name="name"
                  placeholder="Enter full name"
                  required
                />

              </div>

            </div>


            {/* EMAIL + PHONE */}

            <div className="form-row">

              <div className="form-group">

                <label>Email</label>

                <input
                  type="email"
                  name="email"
                  placeholder="Enter email address"
                  required
                />

              </div>


              <div className="form-group">

                <label>Phone Number</label>

                <input
                  type="tel"
                  name="phone"
                  placeholder="Enter phone number"
                />

              </div>

            </div>


            {/* BRANCH + DESIGNATION */}

            <div className="form-row">

              <div className="form-group">

                <label>Branch</label>

                <input
                  type="text"
                  name="branch"
                  placeholder="Enter branch name"
                />

              </div>


              <div className="form-group">

                <label>Designation</label>

                <input
                  type="text"
                  name="designation"
                  placeholder="Example: Relationship Officer"
                />

              </div>

            </div>


            {/* PROFILE PHOTO */}

            <div className="form-row staff-photo-form-row">

              <div className="form-group staff-photo-field">

                <label>Profile Photo</label>

                <input
                  type="file"
                  accept="image/*"
                  onChange={handleStaffPhotoChange}
                />

                <small>Use a clear passport-style photo. It is resized automatically.</small>

                {staffPhotoData && (
                  <img className="staff-photo-preview" src={staffPhotoData} alt="Staff preview" />
                )}

              </div>

            </div>

            {/* PASSWORD */}

            <div className="form-row">

              <div className="form-group">

                <label>Password</label>

                <input
                  type="password"
                  name="password"
                  placeholder="Create login password"
                  required
                />

              </div>

            </div>


            {/* FORM BUTTONS */}

            <div className="form-actions">

              <button
                type="button"
                className="back-dashboard-btn"
                onClick={() => { setStaffPhotoData(""); setShowAddStaffForm(false); }}
              >
                Cancel
              </button>


              <button
                type="submit"
                className="add-staff-btn"
              >
                Create Staff Account
              </button>

            </div>

          </form>

        </div>

      </div>
    );
  }

 // ---------------- STAFF MANAGEMENT LIST ----------------

  return (
    <div className="admin-dashboard">

      {/* HEADER */}

      <div className="dashboard-header">

        <div>

          <h1>Staff Management</h1>

          <p>
            Manage and monitor bank staff members.
          </p>

        </div>


        <button
          className="back-dashboard-btn"
          onClick={() => setStaffPage(false)}
        >
          ← Back to Dashboard
        </button>

      </div>


      {/* STAFF CARD */}

      <div className="staff-management-card">

        {/* CARD HEADER */}

        <div className="staff-management-top">

          <div>

            <h2>Bank Staff</h2>

            <p>
              Add, manage and monitor staff accounts.
            </p>
            <div className="staff-count-badge"><strong>{staffList.length}</strong> Staff Members</div>

          </div>


          <button
            className="add-staff-btn"
            onClick={() => { setStaffPhotoData(""); setShowAddStaffForm(true); }}
          >
            + Add Staff
          </button>

        </div>


        {/* STAFF DATA */}

        {staffList.length === 0 ? (

          /* EMPTY STATE */

          <div className="staff-empty-state">

            <div className="staff-empty-icon">
              👥
            </div>

            <h3>No Staff Members Yet</h3>

            <p>
              Add your bank staff members to start
              assigning targets and monitoring
              their performance.
            </p>

            <button
              className="add-staff-btn"
              onClick={() => { setStaffPhotoData(""); setShowAddStaffForm(true); }}
            >
              + Add First Staff
            </button>

          </div>

        ) : (

          /* STAFF PROFILE CARDS */

          <>
            <div className="staff-directory-grid">
            {staffList.map((staff) => (
              <article className="staff-directory-card" key={staff.staff_id}>
                <div className="staff-card-topline">
                  <span className={`staff-directory-status ${staff.status === "active" ? "is-active" : "is-inactive"}`}>
                    <span className="status-dot"></span>
                    {staff.status === "active" ? "Active" : "Inactive"}
                  </span>
                  <span className="staff-directory-id">{staff.staff_id}</span>
                </div>

                <button
                  type="button"
                  className="staff-profile-trigger"
                  onClick={() => setSelectedStaffProfile(staff)}
                  title={`View ${staff.name} profile`}
                >
                  {staff.photo ? (
                    <img src={staff.photo} alt={staff.name} className="staff-directory-photo" />
                  ) : (
                    <div className="staff-directory-photo staff-photo-placeholder">
                      {(staff.name || "S").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="staff-photo-ring"></span>
                </button>

                <div className="staff-directory-body">
                  <h3>{staff.name}</h3>
                  <p className="staff-directory-designation">{staff.designation || "Bank Staff"}</p>
                  <div className="staff-directory-meta">
                    <span>🏦 {staff.branch || "Branch not set"}</span>
                    <span>✉ {staff.email}</span>
                  </div>
                </div>

                <div className="staff-directory-actions">
                  <button type="button" className="staff-view-btn" onClick={() => setSelectedStaffProfile(staff)}>View Profile</button>
                  <button type="button" className="staff-edit-btn" onClick={() => { setStaffPhotoData(staff.photo || ""); setEditingStaff(staff); }}>Edit</button>
                  {staff.status === "active" ? (
                    <button type="button" className="staff-deactivate-btn" onClick={() => handleDeactivateStaff(staff)}>Deactivate</button>
                  ) : (
                    <>
                      <span className="staff-inactive-label">Inactive</span>
                      <button type="button" className="staff-delete-btn" onClick={() => handlePermanentDeleteStaff(staff)}>Delete</button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>

          {selectedStaffProfile && (
            <div className="staff-profile-modal-backdrop" onClick={() => setSelectedStaffProfile(null)}>
              <div className="staff-profile-modal" onClick={(event) => event.stopPropagation()}>
                <button type="button" className="staff-profile-modal-close" onClick={() => setSelectedStaffProfile(null)}>×</button>
                <div className="staff-profile-modal-hero">
                  {selectedStaffProfile.photo ? (
                    <img src={selectedStaffProfile.photo} alt={selectedStaffProfile.name} className="staff-modal-photo" />
                  ) : (
                    <div className="staff-modal-photo staff-photo-placeholder">{(selectedStaffProfile.name || "S").charAt(0).toUpperCase()}</div>
                  )}
                  <div>
                    <span className="staff-profile-eyebrow">BANK STAFF PROFILE</span>
                    <h2>{selectedStaffProfile.name}</h2>
                    <p>{selectedStaffProfile.designation || "Bank Staff"}</p>
                  </div>
                </div>
                <div className="staff-profile-info-grid">
                  <div><span>Staff ID</span><strong>{selectedStaffProfile.staff_id}</strong></div>
                  <div><span>Branch</span><strong>{selectedStaffProfile.branch || "Not set"}</strong></div>
                  <div><span>Email</span><strong>{selectedStaffProfile.email}</strong></div>
                  <div><span>Phone</span><strong>{selectedStaffProfile.phone || "Not set"}</strong></div>
                  <div><span>Designation</span><strong>{selectedStaffProfile.designation || "Bank Staff"}</strong></div>
                  <div><span>Account Status</span><strong>{selectedStaffProfile.status === "active" ? "Active" : "Inactive"}</strong></div>
                </div>
                <div className="staff-profile-modal-actions">
                  <button type="button" className="staff-edit-btn" onClick={() => { setStaffPhotoData(selectedStaffProfile.photo || ""); setEditingStaff(selectedStaffProfile); setSelectedStaffProfile(null); }}>Edit Staff</button>
                </div>
              </div>
            </div>
          )}
          </>

        )}

      </div>

    </div>
  );
}

  // =========================================================
  // TARGET MANAGEMENT
  // =========================================================
  if (currentPage === "target-management") {
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header">
          <div><h1>Target Management</h1><p>Assign, edit and monitor targets for bank staff.</p></div>
          <button className="back-dashboard-btn" onClick={() => { setEditingTarget(null); setCurrentPage("admin-dashboard"); }}>← Back to Dashboard</button>
        </div>

        {editingTarget ? (
          <div className="staff-management-card">
            <div className="staff-management-top"><div><h2>Edit Target</h2><p>Update the target before work is submitted for verification.</p></div></div>
            <form className="staff-form" onSubmit={handleUpdateTarget}>
              <div className="form-row">
                <div className="form-group"><label>Staff Member</label><input value={`${editingTarget.staff_name} (${editingTarget.staff_id})`} readOnly /></div>
                <div className="form-group"><label>Target Category</label><select name="category" defaultValue={editingTarget.category} required><option>New Accounts</option><option>Loans</option><option>Deposits</option><option>Insurance</option><option>Credit Cards</option><option>Recovery</option><option>Other</option></select></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Target Quantity / Value</label><input type="number" min="1" name="target_value" defaultValue={editingTarget.target_value} required /></div>
                <div className="form-group"><label>Start Date</label><input type="date" name="start_date" defaultValue={editingTarget.start_date} required /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Due Date</label><input type="date" name="due_date" defaultValue={editingTarget.due_date} required /></div>
                <div className="form-group"><label>Remarks</label><input type="text" name="remarks" defaultValue={editingTarget.remarks || ""} placeholder="Target instructions" /></div>
              </div>
              <div className="form-actions"><button type="button" className="back-dashboard-btn" onClick={() => setEditingTarget(null)}>Cancel</button><button type="submit" className="add-staff-btn">Save Changes</button></div>
            </form>
          </div>
        ) : (
          <>
            <div className="staff-management-card">
              <div className="staff-management-top"><div><h2>Assign New Target</h2><p>Create a target and assign it to a staff member.</p></div></div>
              <form className="staff-form" onSubmit={handleAssignTarget}>
                <div className="form-row">
                  <div className="form-group"><label>Staff Member</label><select name="staff_id" required><option value="">Select staff</option>{staffList.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.name} ({s.staff_id})</option>)}</select></div>
                  <div className="form-group"><label>Target Category</label><select name="category" required><option value="">Select category</option><option>New Accounts</option><option>Loans</option><option>Deposits</option><option>Insurance</option><option>Credit Cards</option><option>Recovery</option><option>Other</option></select></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label>Target Quantity / Value</label><input type="number" min="1" name="target_value" required /></div>
                  <div className="form-group"><label>Start Date</label><input type="date" name="start_date" required /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label>Due Date</label><input type="date" name="due_date" required /></div>
                  <div className="form-group"><label>Remarks</label><input type="text" name="remarks" placeholder="Target instructions" /></div>
                </div>
                <div className="form-actions"><button type="submit" className="add-staff-btn">Assign Target</button></div>
              </form>
            </div>
            <div className="staff-management-card">
              <div className="staff-management-top"><div><h2>Assigned Targets</h2><p>Edit active targets or cancel targets that should no longer be worked on.</p></div></div>
              <div className="staff-table-container"><table className="staff-table"><thead><tr><th>Staff</th><th>Category</th><th>Target</th><th>Completed</th><th>Due Date</th><th>Status</th><th>Action</th></tr></thead><tbody>
                {targets.length === 0 ? <tr><td colSpan="7">No targets assigned yet.</td></tr> : targets.map((t) => {
                  const editable = ["ASSIGNED", "IN PROGRESS", "SEND BACK"].includes(t.status);
                  return <tr key={t._id}><td>{t.staff_name} ({t.staff_id})</td><td>{t.category}</td><td>{t.target_value}</td><td>{t.completed_value || 0}</td><td>{t.due_date}</td><td><span className="staff-status">{t.status}</span></td><td>{editable ? <><button type="button" className="add-staff-btn" onClick={() => setEditingTarget(t)}>Edit</button> <button type="button" className="back-dashboard-btn" onClick={() => handleCancelTarget(t._id)}>Cancel</button></> : <span>-</span>}</td></tr>;
                })}
              </tbody></table></div>
            </div>
          </>
        )}
      </div>
    );
  }

  // =========================================================
  // VERIFICATION
  // =========================================================
  if (currentPage === "verification") {
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header"><div><h1>Verification</h1><p>Review completed staff submissions.</p></div><button className="back-dashboard-btn" onClick={() => setCurrentPage("admin-dashboard")}>← Back to Dashboard</button></div>
        {featureMessage && <div style={{marginBottom:"15px",color:"#4ade80"}}>{featureMessage}</div>}
        <div className="staff-management-card"><div className="staff-management-top"><div><h2>Pending Verification</h2><p>Approve completed work or send it back to the staff member.</p></div></div>
          <div className="staff-table-container"><table className="staff-table"><thead><tr><th>Staff</th><th>Target</th><th>Submitted</th><th>Completed</th><th>Remarks</th><th>Action</th></tr></thead><tbody>
            {verificationList.length === 0 ? <tr><td colSpan="6">No submissions are waiting for verification.</td></tr> : verificationList.map((t) => <tr key={t._id}><td>{t.staff_name} ({t.staff_id})</td><td>{t.category}</td><td>{t.submitted_date || "-"}</td><td>{t.completed_value || 0} / {t.target_value}</td><td>{t.submission_remarks || "-"}</td><td><button className="add-staff-btn" onClick={() => handleVerifyTarget(t._id,"approve")}>Approve</button> <button type="button" className="back-dashboard-btn" onClick={() => handleVerifyTarget(t._id,"send_back")}>Send Back</button></td></tr>)}
          </tbody></table></div>
        </div>
      </div>
    );
  }

  // =========================================================
  // ADMIN NOTIFICATIONS
  // =========================================================
  if (currentPage === "admin-notifications") {
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header"><div><h1>Notifications</h1><p>Target assignments and verification updates.</p></div><button className="back-dashboard-btn" onClick={() => setCurrentPage("admin-dashboard")}>← Back to Dashboard</button></div>
        <div className="staff-management-card"><div className="staff-management-top"><div><h2>Admin Notifications</h2><p>Latest system activity.</p></div></div>
          <div className="notification-toolbar"><span>{notifications.filter((n) => !n.read).length} unread</span><button type="button" className="back-dashboard-btn" onClick={handleCleanupReadNotifications}>Clear Read</button></div>
          {notifications.length === 0 ? <div className="staff-empty-state"><div className="staff-empty-icon">🔔</div><h3>No Notifications</h3><p>New target and verification activity will appear here.</p></div> : <div>{notifications.map((n) => <div key={n._id} className={`notification-item ${n.read ? "is-read" : "is-unread"}`}><div><strong>{n.title}</strong><p>{n.message}</p><small>{n.created_at}</small></div><div className="notification-actions">{!n.read && <button type="button" className="notification-read-btn" onClick={() => handleMarkNotificationRead(n._id)}>Mark Read</button>}<button type="button" className="notification-delete-btn" onClick={() => handleDeleteNotification(n._id)}>Delete</button></div></div>)}</div>}
        </div>
      </div>
    );
  }

  // =========================================================
  // SETTINGS
  // =========================================================
  if (currentPage === "settings") {
    const storedAdmin = (() => {
      try { return JSON.parse(localStorage.getItem("bandhan_user") || "null"); } catch { return null; }
    })();
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header">
          <div><h1>Settings</h1><p>Manage application preferences and your current session.</p></div>
          <button className="back-dashboard-btn" onClick={() => setCurrentPage("admin-dashboard")}>← Back to Dashboard</button>
        </div>
        <div className="settings-card">
          <div className="settings-card-header"><div><span className="card-label">ACCOUNT</span><h2>Administrator Session</h2></div></div>
          <div className="settings-grid">
            <div><span>Signed in as</span><strong>{storedAdmin?.user_id || "Administrator"}</strong></div>
            <div><span>Role</span><strong>Administrator</strong></div>
            <div><span>Authentication</span><strong>JWT Protected</strong></div>
            <div><span>Session</span><strong>Secure</strong></div>
          </div>
          <div className="settings-actions">
            <div className="settings-note">Use the theme toggle at the bottom-right to switch between dark and light mode.</div>
            <button className="add-staff-btn" type="button" onClick={() => handleLogout()}>Logout Securely</button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================
  // REPORTS
  // =========================================================
  if (currentPage === "reports") {
    return (
      <div className="admin-dashboard">
        <div className="dashboard-header"><div><h1>Reports</h1><p>Current staff and target performance summary.</p></div><button className="back-dashboard-btn" onClick={() => setCurrentPage("admin-dashboard")}>← Back to Dashboard</button></div>
        <div className="stats-grid">
          <div className="stat-card"><span className="stat-label">Total Staff</span><h3>{reportData?.total_staff ?? 0}</h3><span className="stat-description">Registered staff</span></div>
          <div className="stat-card"><span className="stat-label">Total Targets</span><h3>{reportData?.total_targets ?? 0}</h3><span className="stat-description">Assigned targets</span></div>
          <div className="stat-card"><span className="stat-label">Completed</span><h3>{reportData?.completed ?? 0}</h3><span className="stat-description">Approved targets</span></div>
          <div className="stat-card"><span className="stat-label">Pending Verification</span><h3>{reportData?.pending_verification ?? 0}</h3><span className="stat-description">Awaiting review</span></div>
        </div>
        <div className="staff-management-card"><div className="staff-management-top"><div><h2>Category Summary</h2><p>Targets grouped by category.</p></div></div><div className="staff-table-container"><table className="staff-table"><thead><tr><th>Category</th><th>Total</th><th>Completed</th><th>In Progress</th></tr></thead><tbody>{(reportData?.categories || []).map((c) => <tr key={c.category}><td>{c.category}</td><td>{c.total}</td><td>{c.completed}</td><td>{c.in_progress}</td></tr>)}</tbody></table></div></div>
      </div>
    );
  }

  // =========================================================
  // STAFF FORGOT PASSWORD / EMAIL OTP
  // =========================================================
  if (currentPage === "staff-forgot-password") {
    return (
      <div className="app"><main className="login-page"><button className="back-button" onClick={() => { setCurrentPage("staff-login"); setForgotMessage(""); }}>←</button>
        <div className="login-card admin-login-card"><div className="login-icon admin-login-icon">🔐</div><span className="login-security-label">PASSWORD RECOVERY</span><h1>Reset Password</h1><p className="login-description">Securely reset your staff portal password using an OTP sent to your registered email.</p>
          {forgotStep === "email" && <>
            <div className="input-group"><label>Registered Staff Email</label><div className="input-box"><span className="input-icon">✉</span><input type="email" placeholder="Enter your registered email" value={forgotEmail} onChange={(e)=>setForgotEmail(e.target.value)} autoComplete="email" /></div></div>
            <button className="login-button admin-login-button" onClick={handleForgotPasswordRequest} disabled={forgotLoading}><span>{forgotLoading ? "Sending OTP..." : "Send OTP"}</span><span>→</span></button>
          </>}
          {forgotStep === "otp" && <>
            <div className="input-group"><label>6-Digit OTP</label><div className="input-box"><span className="input-icon">🔢</span><input inputMode="numeric" maxLength="6" placeholder="Enter OTP from email" value={forgotOtp} onChange={(e)=>setForgotOtp(e.target.value.replace(/\D/g, "").slice(0,6))} autoComplete="one-time-code" /></div></div>
            <button className="login-button admin-login-button" onClick={handleVerifyForgotOtp} disabled={forgotLoading}><span>{forgotLoading ? "Verifying..." : "Verify OTP"}</span><span>→</span></button>
            <button type="button" className="forgot-password-link" onClick={() => { setForgotStep("email"); setForgotMessage(""); }}>Resend OTP</button>
          </>}
          {forgotStep === "password" && <>
            <div className="input-group"><label>New Password</label><div className="input-box"><span className="input-icon">🔒</span><input type="password" placeholder="Create a new password" value={forgotNewPassword} onChange={(e)=>setForgotNewPassword(e.target.value)} autoComplete="new-password" /></div></div>
            <div className="input-group"><label>Confirm Password</label><div className="input-box"><span className="input-icon">🔒</span><input type="password" placeholder="Confirm your new password" value={forgotConfirmPassword} onChange={(e)=>setForgotConfirmPassword(e.target.value)} autoComplete="new-password" /></div></div>
            <button className="login-button admin-login-button" onClick={handleResetPassword} disabled={forgotLoading}><span>{forgotLoading ? "Updating..." : "Change Password"}</span><span>✓</span></button>
          </>}
          {forgotMessage && <div style={{marginTop:"15px",color:forgotMessage.toLowerCase().includes("success") || forgotMessage.toLowerCase().includes("sent") || forgotMessage.toLowerCase().includes("verified") ? "#4ade80" : "#ff6b8a",fontSize:"13px"}}>{forgotMessage}</div>}
          <div className="login-security-note">🔒 OTP expires in 5 minutes</div><div className="login-footer">Bandhan Bank Management System</div>
        </div>
      </main></div>
    );
  }

  // =========================================================
  // STAFF LOGIN
  // =========================================================
  if (currentPage === "staff-login") {
    return (
      <div className="app"><main className="login-page"><button className="back-button" onClick={() => {setCurrentPage("home");setStaffLoginMessage("");}}>←</button>
        <div className="login-card admin-login-card"><div className="login-icon admin-login-icon">👤</div><span className="login-security-label">STAFF ACCESS</span><h1>Staff Portal</h1><p className="login-description">Enter your staff credentials to view targets and submit completed work.</p>
          <div className="input-group"><label>Staff ID / Email</label><div className="input-box"><span className="input-icon">✉</span><input ref={staffLoginIdRef} type="text" placeholder="Enter staff ID or email" value={staffLoginId} onChange={(e)=>setStaffLoginId(e.target.value)} autoComplete="username" /></div></div>
          <div className="input-group"><label>Password</label><div className="input-box"><span className="input-icon">🔒</span><input type={showStaffPassword ? "text" : "password"} placeholder="Enter your password" value={staffLoginPassword} onChange={(e)=>setStaffLoginPassword(e.target.value)} autoComplete="current-password" /><button type="button" className="password-toggle" onClick={() => setShowStaffPassword(!showStaffPassword)} aria-label={showStaffPassword ? "Hide password" : "Show password"}>{showStaffPassword ? "👁️" : "👁️‍🗨️"}</button></div></div>
          {staffLoginMessage && <div style={{marginTop:"15px",color:staffLoginMessage === "Login successful!" ? "#4ade80" : "#ff6b8a",fontSize:"13px"}}>{staffLoginMessage}</div>}
          <button className="login-button admin-login-button" onClick={handleStaffLogin} disabled={isStaffLoggingIn}><span>{isStaffLoggingIn ? "Authenticating..." : "Access Staff Portal"}</span><span>→</span></button>
          <button type="button" className="forgot-password-link" onClick={() => { setForgotEmail(staffLoginId.includes("@") ? staffLoginId : ""); setForgotMessage(""); setForgotStep("email"); setCurrentPage("staff-forgot-password"); }}>Forgot Password?</button>
          <div className="login-security-note">🔒 Secure staff authentication</div><div className="login-footer">Bandhan Bank Management System</div>
        </div>
      </main></div>
    );
  }

  // =========================================================
  // STAFF DASHBOARD
  // =========================================================
  if (currentPage === "staff-dashboard") {
    return (
      <div className="dashboard-layout"><aside className="admin-sidebar"><div className="sidebar-brand"><div className="sidebar-logo">B</div><div><h2>Bandhan Bank</h2><span>Staff Portal</span></div></div><div className="sidebar-section-title">MAIN MENU</div><nav className="sidebar-menu">
        <button className="sidebar-menu-item active"><span>▦</span>Dashboard</button>
        <button className="sidebar-menu-item" onClick={()=>setCurrentPage("staff-targets")}><span>🎯</span>My Targets</button>
        <button className="sidebar-menu-item" onClick={()=>setCurrentPage("staff-progress")}><span>📊</span>My Progress</button>
        <button className="sidebar-menu-item" onClick={()=>{setCurrentPage("staff-notifications");loadNotifications("staff",staffUser?.staff_id);}}><span>🔔</span>Notifications</button>
        <button className="sidebar-menu-item" onClick={()=>setCurrentPage("staff-profile")}><span>👤</span>Profile</button>
      </nav><div className="sidebar-bottom"><button className="sidebar-logout" onClick={()=>handleLogout()}><span>↪</span>Logout</button></div></aside>
      <main className="dashboard-main"><header className="dashboard-header"><div><div className="dashboard-page-label">STAFF PORTAL</div><h1>Dashboard</h1></div><div className="dashboard-header-right"><div className="admin-profile"><div className="admin-avatar">{staffUser?.name?.charAt(0) || "S"}</div><div className="admin-profile-text"><strong>{staffUser?.name || "Staff"}</strong><span>{staffUser?.designation || "Bank Staff"}</span></div></div></div></header>
        <section className="dashboard-welcome"><div><span className="welcome-small">Welcome back 👋</span><h2>Track your assigned work <span>efficiently.</span></h2><p>View targets, submit completed work and monitor your progress.</p></div><div className="welcome-icon">🏦</div></section>
        <section className="stats-grid"><div className="stat-card"><span className="stat-label">Assigned</span><h3>{targets.filter(t=>t.staff_id===staffUser?.staff_id).length}</h3><span className="stat-description">Your targets</span></div><div className="stat-card"><span className="stat-label">In Progress</span><h3>{targets.filter(t=>t.staff_id===staffUser?.staff_id && t.status==="IN PROGRESS").length}</h3><span className="stat-description">Work in progress</span></div><div className="stat-card"><span className="stat-label">Pending Verification</span><h3>{targets.filter(t=>t.staff_id===staffUser?.staff_id && t.status==="SUBMITTED FOR VERIFICATION").length}</h3><span className="stat-description">Awaiting admin</span></div><div className="stat-card"><span className="stat-label">Completed</span><h3>{(staffUser?.completed_targets_count || 0)}</h3><span className="stat-description">Approved work</span></div></section>
        <section className="quick-actions"><button className="quick-action" onClick={()=>setCurrentPage("staff-targets")}><span className="quick-action-icon purple-quick">🎯</span><div><strong>My Targets</strong><small>View assigned targets</small></div><span>→</span></button><button className="quick-action" onClick={()=>setCurrentPage("staff-progress")}><span className="quick-action-icon green-quick">📊</span><div><strong>My Progress</strong><small>Track performance</small></div><span>→</span></button></section>
      </main></div>
    );
  }

  // =========================================================
  // STAFF TARGETS
  // =========================================================
  if (currentPage === "staff-targets") {
    const myTargets = targets.filter((t)=>t.staff_id===staffUser?.staff_id);
    return (<div className="admin-dashboard"><div className="dashboard-header"><div><h1>My Targets</h1><p>Targets assigned to you by the administrator.</p></div><button className="back-dashboard-btn" onClick={()=>setCurrentPage("staff-dashboard")}>← Back to Dashboard</button></div><div className="staff-management-card"><div className="staff-table-container"><table className="staff-table"><thead><tr><th>Category</th><th>Target</th><th>Completed</th><th>Due Date</th><th>Status</th><th>Action</th></tr></thead><tbody>{myTargets.length===0?<tr><td colSpan="6">No targets assigned to you yet.</td></tr>:myTargets.map(t=><tr key={t._id}><td>{t.category}</td><td>{t.target_value}</td><td>{t.completed_value||0}</td><td>{t.due_date}</td><td><span className="staff-status">{t.status}</span></td><td>{["ASSIGNED","IN PROGRESS","SEND BACK"].includes(t.status)?<button className="add-staff-btn" onClick={()=>{setSelectedStaffTarget(t);setCurrentPage("submit-target");}}>Submit Work</button>:<span>-</span>}</td></tr>)}</tbody></table></div></div></div>);
  }

  // =========================================================
  // STAFF SUBMISSION
  // =========================================================
  if (currentPage === "submit-target" && selectedStaffTarget) {
    return (<div className="admin-dashboard"><div className="dashboard-header"><div><h1>Submit Completed Work</h1><p>{selectedStaffTarget.category} target • Target: {selectedStaffTarget.target_value}</p></div><button className="back-dashboard-btn" onClick={()=>{setSelectedStaffTarget(null);setCurrentPage("staff-targets");}}>← Back to My Targets</button></div><div className="staff-management-card"><form className="staff-form" onSubmit={handleSubmitTarget}><div className="form-row"><div className="form-group"><label>Completed Quantity / Value</label><input type="number" min="0" name="completed_value" defaultValue={selectedStaffTarget.completed_value||0} required /></div><div className="form-group"><label>Completion Date</label><input type="date" name="completed_date" required /></div></div><div className="form-row"><div className="form-group"><label>Remarks</label><input type="text" name="remarks" placeholder="Describe completed work" /></div></div><div className="form-row"><div className="form-group"><label><input type="checkbox" name="acknowledgement" required /> I acknowledge that the submitted information is correct.</label></div></div><div className="form-actions"><button className="back-dashboard-btn" type="button" onClick={()=>{setSelectedStaffTarget(null);setCurrentPage("staff-targets");}}>Cancel</button><button className="add-staff-btn" type="submit">Submit for Verification</button></div></form></div></div>);
  }

  // =========================================================
  // STAFF PROGRESS
  // =========================================================
  if (currentPage === "staff-progress") {
    const myTargets = targets.filter((t)=>t.staff_id===staffUser?.staff_id);
    const activeTotal = myTargets.length;
    const completed = staffUser?.completed_targets_count || 0;
    const total = activeTotal + completed;
    const percent = total ? Math.round((completed/total)*100) : 0;
    return (<div className="admin-dashboard"><div className="dashboard-header"><div><h1>My Progress</h1><p>Your target completion summary.</p></div><button className="back-dashboard-btn" onClick={()=>setCurrentPage("staff-dashboard")}>← Back to Dashboard</button></div><section className="stats-grid"><div className="stat-card"><span className="stat-label">Total Targets</span><h3>{total}</h3></div><div className="stat-card"><span className="stat-label">Approved</span><h3>{completed}</h3></div><div className="stat-card"><span className="stat-label">Submitted</span><h3>{myTargets.filter(t=>t.status==="SUBMITTED FOR VERIFICATION").length}</h3></div><div className="stat-card"><span className="stat-label">Completion</span><h3>{percent}%</h3></div></section><div className="dashboard-card progress-card"><div className="card-header"><div><span className="card-label">PERFORMANCE</span><h3>My Target Progress</h3></div></div><div className="progress-content"><div className="progress-circle"><div className="progress-circle-inner"><strong>{percent}%</strong><span>Completed</span></div></div><div className="progress-details"><div className="progress-item"><div>✓ Approved</div><strong>{completed}</strong></div><div className="progress-item"><div>⏳ Submitted</div><strong>{myTargets.filter(t=>t.status==="SUBMITTED FOR VERIFICATION").length}</strong></div><div className="progress-item"><div>● Remaining</div><strong>{Math.max(total-completed,0)}</strong></div></div></div></div></div>);
  }

  // =========================================================
  // STAFF NOTIFICATIONS
  // =========================================================
  if (currentPage === "staff-notifications") {
    return (<div className="admin-dashboard"><div className="dashboard-header"><div><h1>Notifications</h1><p>Updates about your targets and submissions.</p></div><button className="back-dashboard-btn" onClick={()=>setCurrentPage("staff-dashboard")}>← Back to Dashboard</button></div><div className="staff-management-card"><div className="notification-toolbar"><span>{notifications.filter((n) => !n.read).length} unread</span><button type="button" className="back-dashboard-btn" onClick={handleCleanupReadNotifications}>Clear Read</button></div>{notifications.length===0?<div className="staff-empty-state"><div className="staff-empty-icon">🔔</div><h3>No Notifications</h3><p>Target assignments and verification results will appear here.</p></div>:notifications.map(n=><div key={n._id} className={`notification-item ${n.read ? "is-read" : "is-unread"}`}><div><strong>{n.title}</strong><p>{n.message}</p><small>{n.created_at}</small></div><div className="notification-actions">{!n.read && <button type="button" className="notification-read-btn" onClick={()=>handleMarkNotificationRead(n._id)}>Mark Read</button>}<button type="button" className="notification-delete-btn" onClick={()=>handleDeleteNotification(n._id)}>Delete</button></div></div>)}</div></div>);
  }

  // =========================================================
  // STAFF PROFILE
  // =========================================================
  if (currentPage === "staff-profile") {
    const myTargetCount = targets.filter((target) => target.staff_id === staffUser?.staff_id).length;
    const approvedTargetCount = staffUser?.completed_targets_count || 0;
    return (
      <div className="staff-profile-page">
        <div className="staff-profile-shell">
          <div className="staff-profile-cover"></div>
          <div className="staff-profile-content">
            <div className="staff-profile-hero-row">
              <div className="staff-profile-avatar-wrap">
                {staffUser?.photo ? (
                  <img src={staffUser.photo} alt={staffUser?.name || "Staff"} className="staff-profile-avatar" />
                ) : (
                  <div className="staff-profile-avatar staff-photo-placeholder">{(staffUser?.name || "S").charAt(0).toUpperCase()}</div>
                )}
                <span className="staff-profile-online-dot"></span>
              </div>
              <div className="staff-profile-identity">
                <span className="staff-profile-kicker">STAFF PROFILE</span>
                <h1>{staffUser?.name || "Staff Member"}</h1>
                <p>⚡ {staffUser?.email || "No email available"}</p>
              </div>
              <button className="back-dashboard-btn staff-profile-back-btn" onClick={() => setCurrentPage("staff-dashboard")}>← Back to Dashboard</button>
            </div>

            <div className="staff-profile-stat-grid">
              <div className="staff-profile-stat"><span>▣</span><small>BRANCH</small><strong>{staffUser?.branch || "Not set"}</strong></div>
              <div className="staff-profile-stat"><span>◆</span><small>DESIGNATION</small><strong>{staffUser?.designation || "Bank Staff"}</strong></div>
              <div className="staff-profile-stat"><span>#</span><small>STAFF ID</small><strong>{staffUser?.staff_id || "—"}</strong></div>
              <div className="staff-profile-stat"><span>✓</span><small>APPROVED WORK</small><strong>{approvedTargetCount}</strong></div>
            </div>

            <div className="staff-profile-detail-grid">
              <section className="staff-profile-panel">
                <span className="staff-profile-panel-label">PROFESSIONAL INFORMATION</span>
                <h2>Your bank profile</h2>
                <p className="staff-profile-muted">Your account details are managed by the administrator.</p>
                <div className="staff-profile-contact-list">
                  <div><span>✉</span><div><small>EMAIL</small><strong>{staffUser?.email || "Not available"}</strong></div></div>
                  <div><span>☎</span><div><small>PHONE</small><strong>{staffUser?.phone || "Not available"}</strong></div></div>
                  <div><span>🏦</span><div><small>BRANCH</small><strong>{staffUser?.branch || "Not assigned"}</strong></div></div>
                </div>
              </section>

              <section className="staff-profile-panel">
                <span className="staff-profile-panel-label">WORK SNAPSHOT</span>
                <h2>Current account activity</h2>
                <div className="staff-profile-work-grid">
                  <div><strong>{myTargetCount}</strong><span>Assigned targets</span></div>
                  <div><strong>{approvedTargetCount}</strong><span>Approved targets</span></div>
                  <div><strong>{staffUser?.status === "active" ? "Active" : "Inactive"}</strong><span>Account status</span></div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================
  // ADMIN DASHBOARD
  // =========================================================

  if (currentPage === "admin-dashboard") {
    return (
      <div className="dashboard-layout">

        {/* ================= SIDEBAR ================= */}

        <aside className="admin-sidebar">

          <div className="sidebar-brand">

            <div className="sidebar-logo">
              B
            </div>

            <div>
              <h2>Bandhan Bank</h2>
              <span>Management System</span>
            </div>

          </div>

          <div className="sidebar-section-title">
            MAIN MENU
          </div>

          <nav className="sidebar-menu">

            <button
              className="sidebar-menu-item active"
            >
              <span>▦</span>
              Dashboard
            </button>

            <button className="sidebar-menu-item"
            onClick={() => { setStaffPage(true); setCurrentPage("admin-dashboard"); }}
            >
              <span>👥</span>
              Staff Management
            </button>

            <button className="sidebar-menu-item" onClick={() => { setCurrentPage("target-management"); loadTargets(); }}>
              <span>🎯</span>
              Target Management
            </button>

            <button className="sidebar-menu-item" onClick={() => { setCurrentPage("verification"); loadVerification(); }}>
              <span>✓</span>
              Verification
            </button>

            <button className="sidebar-menu-item" onClick={() => { setCurrentPage("reports"); loadReports(); }}>
              <span>📊</span>
              Reports
            </button>

            <button className="sidebar-menu-item" onClick={() => { setCurrentPage("admin-notifications"); loadNotifications("admin"); }}>
              <span>🔔</span>
              Notifications
            </button>

          </nav>

          <div className="sidebar-section-title system-title">
            SYSTEM
          </div>

          <nav className="sidebar-menu">

            <button className="sidebar-menu-item" onClick={() => setCurrentPage("settings")}>
              <span>⚙</span>
              Settings
            </button>

          </nav>

          <div className="sidebar-bottom">

            <button
              className="sidebar-logout"
              onClick={() => handleLogout()}
            >
              <span>↪</span>
              Logout
            </button>

          </div>

        </aside>

        {/* ================= MAIN DASHBOARD ================= */}

        <main className="dashboard-main">

          {/* ================= TOP HEADER ================= */}

          <header className="dashboard-header">

            <div>

              <div className="dashboard-page-label">
                ADMIN PORTAL
              </div>

              <h1>
                Dashboard
              </h1>

            </div>

            <div className="dashboard-header-right">

              <button className="notification-button" onClick={() => { setCurrentPage("admin-notifications"); loadNotifications("admin"); }}>
                🔔
                <span className="notification-dot"></span>
              </button>

              <div className="admin-profile">

                <div className="admin-avatar">
                  A
                </div>

                <div className="admin-profile-text">

                  <strong>
                    Administrator
                  </strong>

                  <span>
                    Admin
                  </span>

                </div>

                <span className="profile-arrow">
                  ▾
                </span>

              </div>

            </div>

          </header>

          {/* ================= WELCOME ================= */}

          <section className="dashboard-welcome">

            <div>

              <span className="welcome-small">
                Welcome back 👋
              </span>

              <h2>
                Manage your banking operations
                <span> efficiently.</span>
              </h2>

              <p>
                Monitor staff performance, manage targets,
                verify submissions and track overall progress.
              </p>

            </div>

            <div className="welcome-icon">
              🏦
            </div>

          </section>

          {/* ================= STATISTICS ================= */}

          <section className="stats-grid">

            <div className="stat-card">

              <div className="stat-card-top">

                <div className="stat-icon blue">
                  👥
                </div>

                <span className="stat-trend positive">
                  Live
                </span>

              </div>

              <span className="stat-label">
                Total Staff
              </span>

              <h3>
                {reportData?.total_staff ?? 0}
              </h3>

              <span className="stat-description">
                Active bank staff
              </span>

            </div>

            <div className="stat-card">

              <div className="stat-card-top">

                <div className="stat-icon purple">
                  🎯
                </div>

                <span className="stat-trend positive">
                  Live
                </span>

              </div>

              <span className="stat-label">
                Total Targets
              </span>

              <h3>
                {reportData?.total_targets ?? 0}
              </h3>

              <span className="stat-description">
                Assigned targets
              </span>

            </div>

            <div className="stat-card">

              <div className="stat-card-top">

                <div className="stat-icon green">
                  ✓
                </div>

                <span className="stat-trend positive">
                  Live
                </span>

              </div>

              <span className="stat-label">
                Completed
              </span>

              <h3>
                {reportData?.completed ?? 0}
              </h3>

              <span className="stat-description">
                Successfully completed
              </span>

            </div>

            <div className="stat-card">

              <div className="stat-card-top">

                <div className="stat-icon orange">
                  ⏳
                </div>

                <span className="stat-trend warning">
                  Live
                </span>

              </div>

              <span className="stat-label">
                Pending Verification
              </span>

              <h3>
                {reportData?.pending_verification ?? 0}
              </h3>

              <span className="stat-description">
                Awaiting admin review
              </span>

            </div>

          </section>

          {/* ================= SECOND ROW ================= */}

          <section className="dashboard-grid">

            {/* OVERALL PROGRESS */}

            <div className="dashboard-card progress-card">

              <div className="card-header">

                <div>

                  <span className="card-label">
                    PERFORMANCE
                  </span>

                  <h3>
                    Overall Target Progress
                  </h3>

                </div>

                <button className="card-more">
                  ⋮
                </button>

              </div>

              <div className="progress-content">

                <div className="progress-circle">

                  <div className="progress-circle-inner">

                    <strong>
                      {reportData?.completion_percent ?? 0}%
                    </strong>

                    <span>
                      Completed
                    </span>

                  </div>

                </div>

                <div className="progress-details">

                  <div className="progress-item">

                    <div>
                      <span className="progress-dot completed"></span>
                      Completed
                    </div>

                    <strong>
                      {reportData?.completed ?? 0}
                    </strong>

                  </div>

                  <div className="progress-item">

                    <div>
                      <span className="progress-dot progress"></span>
                      In Progress
                    </div>

                    <strong>
                      {reportData?.in_progress ?? 0}
                    </strong>

                  </div>

                  <div className="progress-item">

                    <div>
                      <span className="progress-dot pending"></span>
                      Pending
                    </div>

                    <strong>
                      {reportData?.pending_verification ?? 0}
                    </strong>

                  </div>

                </div>

              </div>

            </div>

            {/* OVERDUE TARGETS */}

            <div className="dashboard-card overdue-card">

              <div className="card-header">

                <div>

                  <span className="card-label">
                    ATTENTION REQUIRED
                  </span>

                  <h3>
                    Overdue Targets
                  </h3>

                </div>

                <div className="danger-icon">
                  !
                </div>

              </div>

              <div className="overdue-number">
                {reportData?.overdue ?? 0}
              </div>

              <p>
                Targets have passed their due date
                and require attention.
              </p>

              <button className="view-button" onClick={() => { setCurrentPage("target-management"); loadTargets(); }}>
                View Overdue Targets
                <span>→</span>
              </button>

            </div>

          </section>

          {/* ================= RECENT ACTIVITY ================= */}

          <section className="dashboard-card activity-card">

            <div className="card-header">

              <div>

                <span className="card-label">
                  RECENT ACTIVITY
                </span>

                <h3>
                  Target Activity
                </h3>

              </div>

              <button className="view-all-button" onClick={() => { setCurrentPage("admin-notifications"); loadNotifications("admin"); }}>
                View All →
              </button>

            </div>

            <div className="activity-table">

              <div className="table-header">
                <span>STAFF MEMBER</span>
                <span>TARGET</span>
                <span>STATUS</span>
                <span>DATE</span>
              </div>

              {(reportData?.recent_activity || []).length === 0 ? (
                <div className="table-row">
                  <span>No target activity yet.</span>
                  <span>-</span>
                  <span>-</span>
                  <span>-</span>
                </div>
              ) : (reportData.recent_activity || []).map((item) => (
                <div className="table-row" key={item.id}>
                  <div className="staff-cell">
                    <div className="table-avatar">
                      {(item.staff_name || "S").slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <strong>{item.staff_name}</strong>
                      <small>Staff ID: {item.staff_id}</small>
                    </div>
                  </div>
                  <span>{item.category}</span>
                  <span className="status-badge progress-status">{item.status}</span>
                  <span className="table-date">{item.date || "-"}</span>
                </div>
              ))}

            </div>

          </section>
{/* ================= QUICK ACTIONS ================= */}

          <section className="quick-actions">

            <button className="quick-action" onClick={() => setStaffPage(true)}>

              <span className="quick-action-icon">
                👥
              </span>

              <div>
                <strong>
                  Manage Staff
                </strong>

                <small>
                  Add or manage staff
                </small>
              </div>

              <span>
                →
              </span>

            </button>


            <button className="quick-action" onClick={() => { setCurrentPage("target-management"); loadTargets(); }}>

              <span className="quick-action-icon purple-quick">
                🎯
              </span>

              <div>
                <strong>
                  Assign Target
                </strong>

                <small>
                  Create new target
                </small>
              </div>

              <span>
                →
              </span>

            </button>


            <button className="quick-action" onClick={() => { setCurrentPage("verification"); loadVerification(); }}>

              <span className="quick-action-icon green-quick">
                ✓
              </span>

              <div>
                <strong>
                  Verify Work
                </strong>

                <small>
                  Review submissions
                </small>
              </div>

              <span>
                →
              </span>

            </button>


            <button className="quick-action" onClick={() => { setCurrentPage("reports"); loadReports(); }}>

              <span className="quick-action-icon orange-quick">
                📊
              </span>

              <div>
                <strong>
                  View Reports
                </strong>

                <small>
                  Performance reports
                </small>
              </div>

              <span>
                →
              </span>

            </button>

          </section>


          {/* ================= FOOTER ================= */}

          <footer className="dashboard-footer">

            <span>
              © 2026 Bandhan Bank Management System
            </span>

            <span>
              Secure • Professional • Efficient
            </span>

          </footer>

        </main>

      </div>
    );
  }


  // =========================================================
  // ADMIN LOGIN PAGE
  // =========================================================

  if (currentPage === "admin-login") {
    return (
      <div className="app">

        <main className="login-page">

          <button
            className="back-button"
            onClick={() => {
              setCurrentPage("home");
              setLoginMessage("");
            }}
          >
            ←
          </button>


          <div className="login-card admin-login-card">

            <div className="login-icon admin-login-icon">
              🔐
            </div>


            <span className="login-security-label">
              RESTRICTED ACCESS
            </span>


            <h1>
              Admin Portal
            </h1>


            <p className="login-description">
              Authorized personnel only. Please enter your
              administrator credentials to continue.
            </p>


            {/* ADMIN USER ID */}

            <div className="input-group">

              <label>
                Admin Email / ID
              </label>

              <div className="input-box">

                <span className="input-icon">
                  ✉
                </span>

                <input
                  type="text"
                  placeholder="Enter admin email or ID"
                  value={adminUserId}
                  onChange={(e) =>
                    setAdminUserId(e.target.value)
                  }
                />

              </div>

            </div>


            {/* ADMIN PASSWORD */}

            <div className="input-group">

              <label>
                Secure Password
              </label>

              <div className="input-box">

                <span className="input-icon">
                  🔒
                </span>

                <input
                  type={
                    showPassword
                      ? "text"
                      : "password"
                  }
                  placeholder="Enter your password"
                  value={adminPassword}
                  onChange={(e) =>
                    setAdminPassword(e.target.value)
                  }
                />


                <button
                  type="button"
                  className="password-toggle"
                  onClick={() =>
                    setShowPassword(!showPassword)
                  }
                >
                  {showPassword
                    ? "👁️"
                    : "👁️‍🗨️"}
                </button>

              </div>

            </div>


            {/* LOGIN MESSAGE */}

            {loginMessage && (
              <div
                style={{
                  marginTop: "15px",
                  color:
                    loginMessage === "Login successful!"
                      ? "#4ade80"
                      : "#ff6b8a",
                  fontSize: "13px",
                }}
              >
                {loginMessage}
              </div>
            )}


            {/* LOGIN BUTTON */}

            <button
              className="login-button admin-login-button"
              onClick={handleAdminLogin}
              disabled={isLoggingIn}
            >

              <span>
                {isLoggingIn
                  ? "Authenticating..."
                  : "Access Dashboard"}
              </span>

              <span>
                →
              </span>

            </button>


            <div className="login-security-note">
              🔒 Secure administrator authentication
            </div>


            <div className="login-footer">
              Bandhan Bank Management System
            </div>

          </div>

        </main>

      </div>
    );
  }


  // =========================================================
  // HOME PAGE
  // =========================================================

  return (
    <div className="app">


      {/* ================= HEADER ================= */}

      <header className="top-header">

        <div className="brand-section">

          <div className="brand-logo">
            B
          </div>

          <div className="brand-text">

            <h2>
              Bandhan Bank
            </h2>

            <span>
              Management System
            </span>

          </div>

        </div>


        <div className="secure-badge">

          <span>
            🔒
          </span>

          Secure Portal

        </div>

      </header>


      {/* ================= MAIN CONTENT ================= */}

      <main className="main-content">

        <section className="welcome-section">

          <div className="welcome-badge">

            <span>
              ✦
            </span>

            SECURE BANKING MANAGEMENT

          </div>


          <h1>

            Bandhan Bank

            <br />

            <span>
              Management System
            </span>

          </h1>


          <p>

            A secure and intelligent platform for managing staff,
            targets, performance, and work progress.

          </p>

        </section>


        {/* ================= PORTAL CARDS ================= */}

        <section className="portal-section">


          {/* ADMIN */}

          <div className="portal-card admin-card">

            <div className="portal-icon admin-icon">
              🔐
            </div>


            <div className="portal-content">

              <span className="portal-label">
                AUTHORIZED PERSONNEL
              </span>


              <h2>
                Admin Portal
              </h2>


              <p>

                Manage staff, assign targets, verify submissions,
                monitor performance, and access management reports.

              </p>


              <button
                className="portal-button admin-button"
                onClick={() =>
                  setCurrentPage("admin-login")
                }
              >

                <span>
                  Access Admin Portal
                </span>

                <span className="arrow">
                  →
                </span>

              </button>

            </div>

          </div>


          {/* STAFF */}

          <div className="portal-card staff-card">

            <div className="portal-icon staff-icon">
              👤
            </div>


            <div className="portal-content">

              <span className="portal-label">
                BANK STAFF
              </span>


              <h2>
                Staff Portal
              </h2>


              <p>

                View your assigned targets, track progress,
                submit completed work, and manage your profile.

              </p>


              <button
                className="portal-button staff-button"
                onClick={() => setCurrentPage("staff-login")}
              >

                <span>
                  Access Staff Portal
                </span>

                <span className="arrow">
                  →
                </span>

              </button>

            </div>

          </div>

        </section>


        {/* ================= SECURITY INFO ================= */}

        <section className="security-section">


          <div className="security-item">

            <span className="security-icon">
              🔒
            </span>

            <div>

              <strong>
                Secure Access
              </strong>

              <small>
                Protected authentication
              </small>

            </div>

          </div>


          <div className="security-item">

            <span className="security-icon">
              🛡️
            </span>

            <div>

              <strong>
                Role Based Access
              </strong>

              <small>
                Authorized access only
              </small>

            </div>

          </div>


          <div className="security-item">

            <span className="security-icon">
              ✓
            </span>

            <div>

              <strong>
                Secure Management
              </strong>

              <small>
                Controlled staff operations
              </small>

            </div>

          </div>

        </section>

      </main>


      {/* ================= FOOTER ================= */}

      <footer className="footer">

        <p>
          Bandhan Bank Management System
        </p>

        <span>
          Secure • Professional • Efficient
        </span>

      </footer>

    </div>
  );
}

export default App;
