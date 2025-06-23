/**
 * Toast Notification System
 * 
 * This script provides a simple toast notification system for the Koda Labs application.
 * It allows showing toast messages for success, error, info, and warning notifications.
 */

// Toast container to hold all notifications
let toastContainer;

// Initialize the toast system
function initToastSystem() {
  // Create toast container if it doesn't exist
  if (!document.querySelector('.toast-container')) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  } else {
    toastContainer = document.querySelector('.toast-container');
  }
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - The type of toast: 'success', 'error', 'info', 'warning'
 * @param {number} duration - How long to show the toast in milliseconds (default: 3000ms)
 */
function showToast(message, type = 'info', duration = 3000) {
  // Initialize if not already done
  if (!toastContainer) {
    initToastSystem();
  }
  
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  // Create content with appropriate icon
  let icon;
  switch (type) {
    case 'success':
      icon = 'fa-check-circle';
      break;
    case 'error':
      icon = 'fa-exclamation-circle';
      break;
    case 'warning':
      icon = 'fa-exclamation-triangle';
      break;
    case 'info':
    default:
      icon = 'fa-info-circle';
      break;
  }
  
  // Create toast content
  const toastContent = document.createElement('div');
  toastContent.className = 'toast-content';
  toastContent.innerHTML = `
    <i class="fas ${icon}"></i>
    <span>${message}</span>
  `;
  
  // Create close button
  const closeButton = document.createElement('button');
  closeButton.className = 'toast-close-btn';
  closeButton.innerHTML = '&times;';
  closeButton.addEventListener('click', () => {
    closeToast(toast);
  });
  
  // Assemble toast
  toast.appendChild(toastContent);
  toast.appendChild(closeButton);
  
  // Add to container
  toastContainer.appendChild(toast);
  
  // Trigger animation after a small delay to ensure the DOM has updated
  setTimeout(() => {
    toast.classList.add('active');
  }, 10);
  
  // Auto-close after duration
  const timeoutId = setTimeout(() => {
    closeToast(toast);
  }, duration);
  
  // Store timeout ID on the element to clear if manually closed
  toast.dataset.timeoutId = timeoutId;
  
  return toast;
}

/**
 * Close a toast notification
 * @param {HTMLElement} toast - The toast element to close
 */
function closeToast(toast) {
  // Clear the auto-close timeout
  if (toast.dataset.timeoutId) {
    clearTimeout(parseInt(toast.dataset.timeoutId));
  }
  
  // Add closing class for animation
  toast.classList.add('toast-closing');
  
  // Remove after animation completes
  setTimeout(() => {
    if (toast && toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 400); // Match the CSS transition duration
}

// Convenience methods for different toast types
function showSuccessToast(message, duration = 3000) {
  return showToast(message, 'success', duration);
}

function showErrorToast(message, duration = 4000) {
  return showToast(message, 'error', duration);
}

function showInfoToast(message, duration = 3000) {
  return showToast(message, 'info', duration);
}

function showWarningToast(message, duration = 4000) {
  return showToast(message, 'warning', duration);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initToastSystem);
