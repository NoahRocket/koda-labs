# Product Requirements Document: Koda Compass

## 1. Introduction

Koda Compass is a web application designed to be a personal knowledge companion. It aims to help users learn, remember, and organize information effectively by integrating AI assistance, content saving, and learning techniques like active recall.

## 2. Goals

*   Provide a centralized platform for users to interact with an AI assistant for learning and exploration.
*   Enable users to save, organize, and retrieve important information (conversations, bookmarks).
*   Facilitate knowledge retention through features like AI summaries and active recall prompts.
*   Offer a user-friendly interface for managing personal knowledge.

## 3. Target Audience

*   Students
*   Researchers
*   Lifelong learners
*   Content creators
*   Anyone looking to manage and retain information more effectively.

## 4. Key Features

### 4.1. User Authentication
*   **Description:** Users can create an account and log in to access their personal knowledge base.
*   **Requirements:**
    *   Signup page (`pages/signup.html`).
    *   Login page (`pages/login.html`).
    *   Session management (using `localStorage`).
    *   Logout functionality.
*   **Backend:** Supabase likely handles user authentication.

### 4.2. Landing Page (`index.html`)
*   **Description:** Introduces the application, its core value proposition, features, and how it works. Provides entry points for login/signup.
*   **Requirements:**
    *   Hero section with application title and description.
    *   Features section (e.g., Smart Organization, AI Insights, Active Recall).
    *   "How It Works" section.
    *   Testimonials section.
    *   Navigation (responsive).
    *   Call-to-action buttons (Login/Signup).

### 4.3. Dashboard (`pages/dashboard.html`)
*   **Description:** The main landing area for logged-in users, likely providing an overview or access point to other features.
*   **Requirements:** (Specific content needs further investigation)
    *   Redirect logged-in users here.
    *   Provide navigation to other authenticated sections (Chat, Bookmarks, Topics, Settings).

### 4.4. AI Chat Interface (`pages/chat.html`, `chat.js`)
*   **Description:** Allows users to have conversations with an AI assistant.
*   **Requirements:**
    *   Input area for user prompts/questions.
    *   Display area for the conversation history.
    *   Mechanism to send user input to the backend AI service (`/.netlify/functions/chatgpt`).
    *   Display AI responses.

### 4.5. Bookmarks (`pages/bookmarks.html`)
*   **Description:** Enables users to save and manage relevant web links or pieces of information.
*   **Requirements:** (Specific functionality needs further investigation)
    *   Ability to add bookmarks (possibly using `url-metadata` dependency).
    *   Ability to view, organize, and potentially search saved bookmarks.

### 4.6. Topic Management (`pages/topic.html`)
*   **Description:** Allows users to organize saved information (chats, bookmarks) by topic.
*   **Requirements:** (Specific functionality needs further investigation)
    *   Ability to view content grouped by topics.
    *   Potential ability to create, rename, or manage topics.

### 4.7. Settings (`pages/settings.html`)
*   **Description:** Allows users to manage their account settings.
*   **Requirements:** (Specific settings need further investigation)
    *   Profile information.
    *   Account management options (e.g., password change - if applicable).

### 4.8. PDF to Podcast Conversion (`pages/podcasts.html`)
*   **Description:** Allows users to convert PDF documents into audio podcasts by extracting key concepts, generating a conversational script, and converting it to speech.
*   **Requirements:**
    *   PDF upload interface
    *   Concept extraction from PDF text
    *   AI-generated podcast script creation (using OpenAI's API)
    *   Text-to-speech conversion (using ElevenLabs API)
    *   Audio playback of generated podcasts
    *   Storage of podcast files (using Supabase Storage)
    *   Authentication integration for user-specific storage
*   **Backend:**
    *   `upload-pdf.js`: Handles PDF file uploads
    *   `analyze-pdf-text.js`: Extracts key concepts from PDF text
    *   `generate-podcast.js`: Creates podcast script using OpenAI and converts to audio using ElevenLabs

## 5. Non-Functional Requirements

*   **Technology Stack:**
    *   Frontend: HTML, CSS (Tailwind CSS), JavaScript
    *   Backend/DB: Supabase
    *   AI Integration: Netlify Serverless Function calling an external AI API (likely OpenAI).
    *   Deployment: Netlify
*   **Usability:** The application should feature a responsive design suitable for various screen sizes (achieved using Tailwind CSS utility classes).

## 6. Future Considerations / Open Questions

*   The specific implementation details of the Dashboard, Bookmarks, Topics, and Settings pages need further definition.
*   The active recall/spaced repetition feature mentioned on the landing page needs to be implemented or further detailed.
*   The `package.json` mentions "No build step yet", indicating potential future build processes.
