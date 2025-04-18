// scripts/utils.js (Revised)
function showToast(message, type = 'info') { // Use 'success' or 'error' for styled toasts
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container'; // Defined in tailwind-input.css
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  // Base class 'toast', type class 'success' or 'error'
  toast.className = `toast ${type}`; // Defined in tailwind-input.css

  // Create icon element based on type
  const icon = document.createElement('i');
  icon.className = 'fas'; // Base Font Awesome class
  if (type === 'success') {
    icon.classList.add('fa-check-circle'); // Icon class defined in toast component styles
  } else if (type === 'error') {
    icon.classList.add('fa-exclamation-circle'); // Icon class defined in toast component styles
  }
  // Add more types if needed (e.g., fa-info-circle for 'info')

  // Create message span
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;

  // Create content container (optional, but helps with layout if icons/text need specific alignment)
  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.alignItems = 'center';
  content.style.gap = '0.5rem'; // Add some space between icon and text
  content.appendChild(icon);
  content.appendChild(messageSpan);
  toast.appendChild(content);


  // Add close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  // Apply Tailwind classes for styling the close button if preferred,
  // or use inline styles/dedicated CSS class. Using inline for simplicity here.
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '0.25rem';
  closeBtn.style.right = '0.5rem';
  closeBtn.style.background = 'transparent';
  closeBtn.style.border = 'none';
  closeBtn.style.fontSize = '1.5rem'; // Larger close button
  closeBtn.style.lineHeight = '1';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = 'inherit'; // Inherit color from parent (.toast.success/error)
  closeBtn.style.padding = '0.25rem';
  closeBtn.onclick = (e) => {
    e.stopPropagation(); // Prevent triggering other events on the toast
    toast.classList.remove('active'); // Start fade-out
    toast.classList.add('toast-closing');
    // Remove after transition
    toast.addEventListener('transitionend', () => {
      if (toast.parentNode) toast.remove();
      if (toastContainer.children.length === 0) {
        toastContainer.remove();
      }
    }, { once: true }); // Ensure listener is removed after firing
  };
  toast.appendChild(closeBtn);
  toast.style.position = 'relative'; // Parent needs position:relative for absolute child


  toastContainer.appendChild(toast);

  // Trigger fade-in animation
  requestAnimationFrame(() => {
    toast.classList.add('active'); // Class defined in tailwind-input.css
  });

  // Set auto-remove timer
  const autoRemoveTimer = setTimeout(() => {
    if (toast.parentNode) { // Check if it hasn't been closed manually
      closeBtn.onclick({ stopPropagation: () => {} }); // Trigger the close logic
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
