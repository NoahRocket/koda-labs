# Product Requirements Document: Koda Tutor

## 1. Introduction

Koda Tutor is a web application designed to be a personal knowledge companion. It aims to help users learn, remember, and organize information effectively by integrating AI assistance, content saving, and learning techniques like active recall.

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

### 4.1. Subscription Plans
*   **Description:** Tiered subscription model offering free and premium access levels.
*   **Requirements:**
    *   Free tier with basic functionality.
    *   Premium tier with advanced features and unlimited access.
    *   Monthly and yearly billing options with appropriate pricing.
    *   Pricing page (`pages/pricing.html`) to display subscription options.
    *   Integration with Stripe for payment processing.
    *   Stripe Customer Portal for subscription management.
*   **Backend:** 
    *   Stripe API integration for payment processing.
    *   Netlify Functions for handling checkout sessions and webhooks.
    *   Supabase database for storing subscription data.

### 4.2. User Authentication
*   **Description:** Users can create an account and log in to access their personal knowledge base.
*   **Requirements:**
    *   Signup page (`pages/signup.html`).
    *   Login page (`pages/login.html`).
    *   Session management (using `localStorage`).
    *   Logout functionality.
*   **Backend:** Supabase likely handles user authentication.

### 4.3. Landing Page (`index.html`)
*   **Description:** Introduces the application, its core value proposition, features, and how it works. Provides entry points for login/signup.
*   **Requirements:**
    *   Hero section with application title and description.
    *   Features section (e.g., Smart Organization, AI Insights, Active Recall).
    *   "How It Works" section.
    *   Testimonials section.
    *   Navigation (responsive).
    *   Call-to-action buttons (Login/Signup).

### 4.4. Dashboard (`pages/dashboard.html`)
*   **Description:** The main landing area for logged-in users, likely providing an overview or access point to other features.
*   **Requirements:** (Specific content needs further investigation)
    *   Redirect logged-in users here.
    *   Provide navigation to other authenticated sections (Chat, Bookmarks, Topics, Settings).

### 4.5. AI Chat Interface (`pages/chat.html`, `chat.js`)
*   **Description:** Allows users to have conversations with an AI assistant.
*   **Requirements:**
    *   Input area for user prompts/questions.
    *   Display area for the conversation history.
    *   Mechanism to send user input to the backend AI service (`/.netlify/functions/chatgpt`).
    *   Display AI responses.

### 4.6. Bookmarks (`pages/bookmarks.html`)
*   **Description:** Enables users to save and manage relevant web links or pieces of information.
*   **Requirements:** (Specific functionality needs further investigation)
    *   Ability to add bookmarks (possibly using `url-metadata` dependency).
    *   Ability to view, organize, and potentially search saved bookmarks.

### 4.6. Topic Management (`pages/topic-view.html`)
*   **Description:** Allows users to organize saved information (chats, bookmarks) by topic.
*   **Requirements:** (Specific functionality needs further investigation)
    *   Ability to view content grouped by topics.
    *   Potential ability to create, rename, or manage topics.
    *   **YouTube Video Recommendations:** Display relevant YouTube videos based on the topic name in a dedicated 'Videos' tab within the topic view.
    *   Premium features may include advanced topic management capabilities.

### 4.7. Settings (`pages/settings.html`)
*   **Description:** Allows users to manage their account settings and subscription status.
*   **Requirements:**
    *   Profile information.
    *   Account management options (e.g., password change - if applicable).
    *   Subscription status display showing current plan (Free/Premium).
    *   Ability to manage existing subscriptions via the Stripe Customer Portal.
    *   Integration with `create-portal-session.js` to redirect to Stripe.

### 4.9. PDF to Podcast Conversion (`pages/podcasts.html`)
*   **Description:** Allows users to convert PDF documents into audio podcasts by extracting key concepts, generating a conversational script, and converting it to speech using an asynchronous job-based architecture to handle long-running processes.
*   **Requirements:**
    *   PDF upload interface
    *   Concept extraction from PDF text
    *   AI-generated podcast script creation (using OpenAI's API)
    *   Text-to-speech conversion (using ElevenLabs API)
    *   Job status monitoring and progress indication
    *   Audio playback of generated podcasts
    *   Storage of podcast files (using Supabase Storage)
    *   Authentication integration for user-specific storage
*   **Backend Processing Pipeline:**
    *   `upload-pdf.js`: Handles PDF file uploads and text extraction
    *   `analyze-pdf-text.js`: Extracts key concepts from PDF text using OpenAI
    *   `generate-script-background.js`: Orchestrates script generation and triggers TTS conversion
    *   `generate-tts-background.js`: Handles long-running text-to-speech conversion as a background process
    *   `direct-upload.js`: Manages uploading generated audio to Supabase Storage
    *   `check-podcast-status.js`: Allows users to check the status of podcast generation jobs

## 5. Subscription Functionality

### 5.1. Pricing Page (`pages/pricing.html`)
*   **Description:** Displays available subscription plans with pricing and features.
*   **Requirements:**
    *   Toggle between monthly and yearly billing options.
    *   Clear display of pricing for each plan.
    *   Feature comparison between free and premium tiers.
    *   Call-to-action buttons for subscription checkout.
*   **Integration:** Connected to `create-checkout-session.js` to initiate Stripe checkout.

### 5.2. Stripe Integration
*   **Description:** Backend services for managing subscriptions through Stripe.
*   **Components:**
    *   `create-checkout-session.js`: Creates a Stripe checkout session for new subscriptions.
    *   `create-portal-session.js`: Creates a Stripe customer portal session for managing existing subscriptions.
    *   `check-subscription.js`: Verifies user subscription status.
    *   `stripe-webhook.js`: Processes Stripe webhook events to update subscription status.
    *   `stripeClient.js`: Utility functions for Stripe operations.

## 6. Non-Functional Requirements

*   **Technology Stack:**
    *   Frontend: HTML, CSS (Tailwind CSS), JavaScript
    *   Backend/DB: Supabase
    *   AI Integration: Netlify Serverless Functions calling external AI APIs (e.g., OpenAI, YouTube Data API v3).
    *   **API Keys:** Requires environment variables for `OPENAI_API_KEY`, `YOUTUBE_API_KEY`, `ELEVENLABS_API_KEY`, etc., to be configured in Netlify.
    *   Deployment: Netlify
*   **Usability:** The application should feature a responsive design suitable for various screen sizes (achieved using Tailwind CSS utility classes).

## 6. Future Considerations / Open Questions

*   The specific implementation details of the Dashboard, Bookmarks, Topics, and Settings pages need further definition.
*   The active recall/spaced repetition feature mentioned on the landing page needs to be implemented or further detailed.
*   The `package.json` mentions "No build step yet", indicating potential future build processes.
