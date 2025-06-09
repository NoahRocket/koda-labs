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


function checkAuth(basePath = '') {
  const userId = localStorage.getItem('userId');
  const accessToken = localStorage.getItem('accessToken');
  const currentPage = window.location.pathname.split('/').pop();
  
  // Define pages that do NOT require authentication
  const publicPages = ['index.html', 'login.html', 'signup.html', '']; // '' for root, adjust as needed

  if (!userId || !accessToken) {
    // If the current page is NOT public AND user is not authenticated, redirect to login.
    if (!publicPages.includes(currentPage)) {
      console.warn(`User not authenticated. Redirecting to login page from ${currentPage}.`);
      // Ensure basePath ends with a slash if it's not empty, for proper URL construction.
      const redirectPath = basePath ? (basePath.endsWith('/') ? basePath : basePath + '/') : '';
      window.location.href = redirectPath + 'index.html'; 
    }
  } else {
    // User is authenticated.
    // If they are on a login/signup page, redirect them to the dashboard.
    if (currentPage === 'login.html' || currentPage === 'signup.html') {
        console.log('User authenticated. Redirecting from auth page to dashboard.');
        const redirectPath = basePath ? (basePath.endsWith('/') ? basePath : basePath + '/') : '';
        window.location.href = redirectPath + 'pages/dashboard.html';
    }
  }
}

async function loadTutorAvatarInternal() {
  const userAvatarSidebar = document.getElementById('userAvatarSidebar');
  const avatarLoading = document.getElementById('avatarLoading');

  if (!userAvatarSidebar || !avatarLoading) {
    console.warn('User avatar element #userAvatarSidebar or #avatarLoading not found.');
    if (userAvatarSidebar) userAvatarSidebar.src = '../assets/avatars/default.png'; // Attempt to set default even if spinner missing
    return;
  }

  // Show spinner, hide image initially
  userAvatarSidebar.classList.add('opacity-0');
  avatarLoading.classList.remove('hidden');

  const userId = localStorage.getItem('userId');
  const accessToken = localStorage.getItem('accessToken');

  if (!userId || !accessToken) {
    console.warn('Cannot load avatar: User not authenticated.');
    userAvatarSidebar.src = '../assets/avatars/default.png'; // Default avatar
    userAvatarSidebar.classList.remove('opacity-0');
    avatarLoading.classList.add('hidden');
    return;
  }

  const cachedAvatarUrl = localStorage.getItem('userAvatarUrl');
  if (cachedAvatarUrl) {
    userAvatarSidebar.src = cachedAvatarUrl;
    userAvatarSidebar.classList.remove('opacity-0');
    avatarLoading.classList.add('hidden');
    return; 
  }

  try {
    const response = await fetch('/.netlify/functions/dashboard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ action: 'getAvatar', userId: userId })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Failed to load tutor avatar:', response.status, errorData);
      userAvatarSidebar.src = '../assets/avatars/default.png';
      userAvatarSidebar.classList.remove('opacity-0');
      avatarLoading.classList.add('hidden');
      return;
    }

    const data = await response.json();
    if (data.avatarUrl) {
      userAvatarSidebar.src = data.avatarUrl;
      localStorage.setItem('userAvatarUrl', data.avatarUrl);
    } 
    userAvatarSidebar.classList.remove('opacity-0');
    avatarLoading.classList.add('hidden');
    if (!data.avatarUrl) {
      console.warn('Avatar URL not found in response, using default.');
      userAvatarSidebar.src = '../assets/avatars/default.png';
    }
  } catch (error) {
    console.error('Error fetching tutor avatar:', error);
    userAvatarSidebar.src = '../assets/avatars/default.png';
    userAvatarSidebar.classList.remove('opacity-0'); // Still ensure default is shown
    avatarLoading.classList.add('hidden');
  }
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
