// Theme management for Koda Labs
document.addEventListener('DOMContentLoaded', () => {
  initializeTheme();
});

// Initialize theme based on stored preference or system preference
function initializeTheme() {
  const darkModeToggle = document.getElementById('darkModeToggle');
  if (!darkModeToggle) return; // Not on a page with the toggle

  // Check if user has a saved preference
  const savedTheme = localStorage.getItem('themePreference');
  
  // If no saved preference, check system preference
  if (savedTheme === null) {
    const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDarkMode) {
      setDarkMode(true);
      darkModeToggle.checked = true;
    }
  } else {
    // Apply saved preference
    const isDarkMode = savedTheme === 'dark';
    setDarkMode(isDarkMode);
    darkModeToggle.checked = isDarkMode;
  }

  // Add event listener for toggle
  darkModeToggle.addEventListener('change', function() {
    const isDarkMode = this.checked;
    setDarkMode(isDarkMode);
    saveThemePreference(isDarkMode ? 'dark' : 'light');
  });
}

// Apply dark mode or light mode to the document
function setDarkMode(isDarkMode) {
  if (isDarkMode) {
    document.documentElement.classList.add('dark-mode');
  } else {
    document.documentElement.classList.remove('dark-mode');
  }
}

// Save theme preference to localStorage and server
async function saveThemePreference(theme) {
  // Save to localStorage for immediate use
  localStorage.setItem('themePreference', theme);
  
  // Save to server if user is logged in
  const userId = localStorage.getItem('userId');
  const accessToken = localStorage.getItem('accessToken');
  
  if (userId && accessToken) {
    try {
      const response = await fetch('/.netlify/functions/dashboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          action: 'updateThemePreference',
          userId,
          theme
        })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        console.error('Failed to save theme preference:', data.error);
      }
    } catch (error) {
      console.error('Error saving theme preference:', error);
    }
  }
}

// Function to apply theme on page load (can be called from any page)
function applyTheme() {
  const savedTheme = localStorage.getItem('themePreference');
  
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark-mode');
  } else if (savedTheme === 'light') {
    document.documentElement.classList.remove('dark-mode');
  } else {
    // Check system preference if no saved preference
    const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDarkMode) {
      document.documentElement.classList.add('dark-mode');
    }
  }
}

// Apply theme immediately when script loads
applyTheme();
