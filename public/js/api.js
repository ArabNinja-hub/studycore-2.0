// =============================================
// STUDYCORE — API Client (js/api.js)
// By Dr. Relentless | Stay Curious & Winning
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

    // Course Home
    courseHome: (subject) => request(`/api/courses/${encodeURIComponent(subject)}`),
    markComplete: (id) => request(`/api/resources/${id}/complete`, { method: 'POST' }),
    markIncomplete: (id) => request(`/api/resources/${id}/complete`, { method: 'DELETE' }),
    myCompleted: () => request('/api/resources/completed/mine'),
    submitQuizAttempt: (id, score, total) => request(`/api/resources/${id}/quiz-attempt`, { method: 'POST', body: JSON.stringify({ score, total }) }),
    myQuizAttempts: (id) => request(`/api/resources/${id}/quiz-attempts/mine`),

    // Public/student resources
    listResources: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return request(`/api/resources?${qs.toString()}`);
    },
    getResource: (id) => request(`/api/resources/${id}`),
    downloadUrl: (id) => `/api/resources/${id}/download`,
    myBookmarks: () => request('/api/resources/bookmarks/mine'),
    myDownloads: () => request('/api/resources/downloads/mine'),
    bookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'POST' }),
    unbookmark: (id) => request(`/api/resources/${id}/bookmark`, { method: 'DELETE' }),

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
        else reject(new Error((data && data.message) || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(formData);
    });
  };

  global.StudyCoreAPI = StudyCoreAPI;
})(window);
