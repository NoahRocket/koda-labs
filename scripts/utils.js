// scripts/utils.js (Revised)
function showToast(message, type = 'info') {
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  // Create icon element based on type
  const icon = document.createElement('i');
  icon.className = 'fas';
  if (type === 'success') {
    icon.classList.add('fa-check-circle');
  } else if (type === 'error') {
    icon.classList.add('fa-exclamation-circle');
  }

  // Create message span
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;

  // Create content container
  const content = document.createElement('div');
  content.className = 'toast-content';
  content.appendChild(icon);
  content.appendChild(messageSpan);
  toast.appendChild(content);

  // Add close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.className = 'toast-close-btn';
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    toast.classList.remove('active');
    toast.classList.add('toast-closing');
    toast.addEventListener('transitionend', () => {
      if (toast.parentNode) toast.remove();
      if (toastContainer.children.length === 0) {
        toastContainer.remove();
      }
    }, { once: true });
  };
  toast.appendChild(closeBtn);

  toastContainer.appendChild(toast);

  // Trigger fade-in animation
  requestAnimationFrame(() => {
    toast.classList.add('active');
  });

  // Set auto-remove timer
  const autoRemoveTimer = setTimeout(() => {
    if (toast.parentNode) {
      closeBtn.onclick({ stopPropagation: () => {} });
    }
  }, 5000);

  // Clear timer if closed manually
  closeBtn.addEventListener('click', () => clearTimeout(autoRemoveTimer), { once: true });
}

// Check login status and update navigation for pages like index, login, signup
function updateNavigation() {
  const isLoggedIn = localStorage.getItem('userId') && localStorage.getItem('accessToken');
  const loggedInNav = document.getElementById('loggedInNav');
  const loggedOutNav = document.getElementById('loggedOutNav');
  const logoutContainer = document.getElementById('logoutContainer');
  
  // Get current page
  const currentPage = window.location.pathname.split('/').pop();
  const isLandingPage = currentPage === '' || currentPage === 'index.html';
  
  // Handle redirects for authenticated users on auth pages
  if (isLoggedIn && ['login.html', 'signup.html'].includes(currentPage)) {
    // Redirect to dashboard if on login/signup pages
    window.location.href = '/pages/dashboard.html';
    return;
  }
  
  // Update navigation visibility based on login status
  if (isLoggedIn) {
    // User is logged in
    if (loggedInNav) loggedInNav.classList.remove('hidden');
    if (loggedOutNav) loggedOutNav.classList.add('hidden');
    if (logoutContainer) logoutContainer.classList.remove('hidden');
  } else {
    // User is not logged in
    if (loggedInNav) loggedInNav.classList.add('hidden');
    if (loggedOutNav) loggedOutNav.classList.remove('hidden');
    if (logoutContainer) logoutContainer.classList.add('hidden');
  }
}

// Silent session refresh: use refresh token to renew access token before expiry
let refreshTimer;
async function refreshSession() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return;
  try {
    const response = await fetch('/.netlify/functions/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', refreshToken }),
    });
    if (!response.ok) throw new Error('Failed to refresh session');
    const result = await response.json();
    localStorage.setItem('accessToken', result.session.access_token);
    localStorage.setItem('refreshToken', result.session.refresh_token);
    const expiresIn = result.session.expires_in || 900;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshSession, (expiresIn - 60) * 1000);
  } catch (err) {
    console.error('Session refresh failed:', err);
    localStorage.removeItem('userId');
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  }
}

// Helper function to handle common event handling tasks
function handleMenuEvent(event, action) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

document.addEventListener('DOMContentLoaded', () => {
  const currentPage = window.location.pathname.split('/').pop();
  if (currentPage !== 'login.html' && currentPage !== 'signup.html') {
    refreshSession();
  }
  
  // Mobile Menu Behavior
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const closeSidebar = document.getElementById('closeSidebar');
  
  if (hamburger && sidebar) {
    // Make sure hamburger has a larger tap area
    hamburger.style.padding = '15px';
    
    // Initial state - ensure mobile menu is hidden on small screens
    if (window.innerWidth < 768) {
      sidebar.classList.add('-translate-x-full');
    }
    
    // Toggle menu visibility
    hamburger.addEventListener('click', function(e) {
      handleMenuEvent(e, () => {
        sidebar.classList.toggle('-translate-x-full');
      });
    });
    
    // Close sidebar when close button is clicked
    if (closeSidebar) {
      closeSidebar.addEventListener('click', function(e) {
        handleMenuEvent(e, () => {
          sidebar.classList.add('-translate-x-full');
        });
      });
    }
  }
});
