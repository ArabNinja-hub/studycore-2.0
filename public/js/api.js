// =============================================
// STUDYCORE — API Client (js/api.js)
// -----------------------------------------------
// Every request goes through here. Auth is a real httpOnly cookie set by
// the server on login/signup (see server.js + middleware/auth.js) - the
// browser sends it automatically on same-origin requests as long as we
// pass `credentials: 'include'`. There is no token in localStorage to
// spoof, and no client-side role logic anywhere in this file.
// =============================================

(function (global) {
  'use strict';

  async function request(path, options = {}) {
    const isFormData = options.body instanceof FormData;
    const res = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: isFormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      const error = new Error((data && data.message) || `Request failed (${res.status})`);
      error.status = res.status;
      error.locked = Boolean(data && data.locked);
      error.lockReason = data && data.lockReason ? data.lockReason : null;
      throw error;
    }
    return data;
  }

  const StudyCoreAPI = {
    // Auth
    register: (payload) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
    login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: () => request('/api/auth/me'),
    updateProfile: (payload) => request('/api/auth/profile', { method: 'PUT', body: JSON.stringify(payload) }),
    changePassword: (payload) => request('/api/auth/password', { method: 'PUT', body: JSON.stringify(payload) }),
    subscribe: (payload) => request('/api/auth/subscribe', { method: 'POST', body: JSON.stringify(payload) }),
    paymentInfo: () => request('/api/auth/payment-info'),
    config: () => request('/api/auth/config'),
    myReferral: () => request('/api/auth/referral'),

    // Profile picture (server validates type + signature, stores in R2)
    avatarUrl: () => '/api/auth/avatar',
    uploadAvatar: (file) => {
      const fd = new FormData();
      fd.append('avatar', file);
      return request('/api/auth/avatar', { method: 'POST', body: fd });
    },
    removeAvatar: () => request('/api/auth/avatar', { method: 'DELETE' }),

    // Courses
    listCourses: () => request('/api/courses'),
    courseHome: (subject) => request(`/api/courses/${encodeURIComponent(subject)}`),
    lessonFlow: (id) => request(`/api/courses/lesson/${encodeURIComponent(id)}`),

    // Progress
    markComplete: (id) => request(`/api/resources/${id}/complete`, { method: 'POST' }),
    markIncomplete: (id) => request(`/api/resources/${id}/complete`, { method: 'DELETE' }),
    myCompleted: () => request('/api/resources/completed/mine'),
    saveVideoProgress: (id, position, duration) => request(`/api/resources/${id}/video-progress`, {
      method: 'POST', body: JSON.stringify({ position, duration })
    }),
    getVideoProgress: (id) => request(`/api/resources/${id}/video-progress`),

    // Resources
    listResources: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return request(`/api/resources?${qs.toString()}`);
    },
    getResource: (id) => request(`/api/resources/${id}`),
    streamUrl: (id) => `/api/resources/${id}/stream`,
    myBookmarks: () => request('/api/resources/bookmarks/mine'),
    bookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'POST' }),
    unbookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'DELETE' }),

    // Notifications & Announcements
    getNotifications: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const qStr = qs.toString();
      return request(`/api/notifications${qStr ? `?${qStr}` : ''}`);
    },
    getUnreadNotificationCount: () => request('/api/notifications/unread-count'),
    markNotificationRead: (id) => request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllNotificationsRead: () => request('/api/notifications/read-all', { method: 'POST' }),

    // Admin
    adminListResources: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return request(`/api/admin/resources?${qs.toString()}`);
    },
    adminCreateResource: (formData) => request('/api/admin/resources', { method: 'POST', body: formData }),
    adminUpdateResource: (id, formData) => request(`/api/admin/resources/${id}`, { method: 'PUT', body: formData }),
    adminDeleteResource: (id) => request(`/api/admin/resources/${id}`, { method: 'DELETE' }),
    adminListUsers: () => request('/api/admin/users'),
    adminDeleteUser: (id) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
    adminAnalytics: () => request('/api/admin/analytics'),
    adminListPayments: (status) => request(`/api/admin/payments${status ? `?status=${status}` : ''}`),
    adminApprovePayment: (id) => request(`/api/admin/payments/${id}/approve`, { method: 'POST' }),
    adminRejectPayment: (id) => request(`/api/admin/payments/${id}/reject`, { method: 'POST' })
  };

  // XHR wrapper so we can report real upload progress (fetch can't do this yet).
  StudyCoreAPI.uploadWithProgress = function (url, method, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const err = new Error((data && data.message) || `Upload failed (${xhr.status})`);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(formData);
    });
  };

  global.StudyCoreAPI = StudyCoreAPI;
})(window);
