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
  try {
    // Create toast container if it doesn't exist
    if (!document.getElementById('toast-container')) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
      console.log('Toast container created');
    } else {
      toastContainer = document.getElementById('toast-container');
      console.log('Using existing toast container');
    }
    
    // Double check that the container is actually in the DOM
    if (!document.getElementById('toast-container')) {
      console.error('Toast container was created but not found in the DOM');
      // Try again with a slight delay to ensure DOM is ready
      setTimeout(() => {
        if (!document.getElementById('toast-container')) {
          toastContainer = document.createElement('div');
          toastContainer.id = 'toast-container';
          toastContainer.className = 'toast-container';
          document.body.appendChild(toastContainer);
          console.log('Toast container created on retry');
        }
      }, 100);
    }
  } catch (error) {
    console.error('Error initializing toast system:', error);
  }
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - The type of toast: 'success', 'error', 'info', 'warning'
 * @param {number} duration - How long to show the toast in milliseconds (default: 3000ms)
 */
function showToast(message, type = 'info', duration = 3000) {
  // Always ensure we have a toast container
  if (!toastContainer || !document.getElementById('toast-container')) {
    initToastSystem();
    // Short delay to ensure container is created
    setTimeout(() => showToastImpl(message, type, duration), 50);
    return null;
  } else {
    return showToastImpl(message, type, duration);
  }
}

/**
 * Internal implementation of showToast after container is verified
 */
function showToastImpl(message, type = 'info', duration = 3000) {
  // Validate message to prevent empty toasts
  if (!message || message.trim() === '') {
    console.warn('Attempted to show toast with empty message');
    message = type === 'error' ? 'An error occurred during processing' : 
              type === 'success' ? 'Operation completed successfully' : 
              type === 'warning' ? 'Process warning' : 'Processing update';
  }
  
  // Double check that we have a container
  if (!toastContainer || !document.getElementById('toast-container')) {
    console.error('Failed to create toast container');
    return null;
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
  if (!toast) return;
  
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

// Also initialize when the window loads (backup)
window.addEventListener('load', initToastSystem);
