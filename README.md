# Koda Labs

Koda Tutor is a personal knowledge companion that helps users learn, remember, and organize information effectively through AI assistance and knowledge management tools.

## Features

- **Subscription System**: Tiered pricing with free and premium plans, offering monthly and yearly billing options.
- **AI Chat Interface**: Converse with an AI assistant to explore and learn new topics.
- **Dashboard**: Central hub for accessing all your saved knowledge.
- **Topic Management**: Organize saved content by topic for better retrieval. Includes displaying YouTube video recommendations relevant to the topic.
- **Bookmarks**: Save and organize web links and important information.
- **PDF to Podcast**: Convert PDFs to audio podcasts for on-the-go learning.

## Subscription System

Koda Labs offers a tiered subscription model to provide flexibility for different user needs:

1. **Free Plan**: Basic features with limited access
2. **Premium Plan**: Full access to all features and advanced functionality

The subscription system is built with the following components:

1. **Pricing Page** (`pages/pricing.html`): Displays subscription options with a toggle between monthly and yearly billing.
2. **Stripe Integration**: Handles payment processing and subscription management.
3. **Subscription Management** (`pages/settings.html`): Allows users to view their current subscription status and manage their subscription.
4. **Backend Processing**:
   - `create-checkout-session.js`: Creates a Stripe checkout session for new subscriptions
   - `create-portal-session.js`: Creates a Stripe customer portal session for managing existing subscriptions
   - `check-subscription.js`: Verifies user subscription status
   - `stripe-webhook.js`: Processes Stripe webhook events
   - `stripeClient.js`: Utility functions for Stripe operations

## PDF to Podcast Feature

The PDF to Podcast feature transforms uploaded PDF documents into engaging audio podcasts through an asynchronous, job-based processing pipeline designed to handle long-running operations efficiently:

1. **PDF Upload & Text Extraction** (`upload-pdf.js`): Users upload PDFs, and the system extracts text content.
2. **Concept Extraction** (`analyze-pdf-text.js`): The system analyzes the text and extracts key concepts and explanations using OpenAI.
3. **Job Management** (`queue-podcast-job.js`): Creates a podcast generation job and tracks its status throughout the process.
4. **Script Generation** (`process-podcast-job.js`): Using OpenAI, the system creates a conversational podcast script based on the extracted concepts.
5. **Background Text-to-Speech** (`generate-tts-background.js`): The script is converted to natural-sounding speech using ElevenLabs' API in a background process to avoid timeout issues.
6. **Storage Upload** (`direct-upload.js`): The generated MP3 is stored securely in Supabase Storage.
7. **Status Monitoring** (`check-podcast-status.js`): Provides real-time status updates as the podcast generation progresses.

This architecture effectively handles potentially long-running processes while providing a responsive user experience.

## Technical Implementation

- **Frontend**: HTML, CSS (Tailwind), JavaScript
- **Backend**: Netlify Serverless Functions (Node.js)
- **Database & Storage**: Supabase
- **APIs**: 
  - Stripe for payment processing and subscription management
  - OpenAI for script generation and other AI tasks
  - ElevenLabs for text-to-speech
  - YouTube Data API v3 for video recommendations
  
## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `YOUTUBE_API_KEY`
4. Run locally: `netlify dev`

## Environment Variables

Create a `.env` file in the root directory with the following:

```
SUPABASE_URL=your-supabase-url
SUPABASE_KEY=your-supabase-anon-key
OPENAI_API_KEY=your-openai-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
YOUTUBE_API_KEY=your-youtube-data-api-key
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_PUBLISHABLE_KEY=your-stripe-publishable-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret
STRIPE_MONTHLY_PRICE_ID=your-stripe-monthly-price-id
STRIPE_YEARLY_PRICE_ID=your-stripe-yearly-price-id