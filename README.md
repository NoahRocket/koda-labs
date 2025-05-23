# Koda Labs

Koda Tutor is a personal knowledge companion that helps users learn, remember, and organize information effectively through AI assistance and knowledge management tools.

## Features

- **AI Chat Interface**: Converse with an AI assistant to explore and learn new topics.
- **Dashboard**: Central hub for accessing all your saved knowledge.
- **Topic Management**: Organize saved content by topic for better retrieval.
- **Bookmarks**: Save and organize web links and important information.
- **PDF to Podcast**: Convert PDFs to audio podcasts for on-the-go learning.

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
  - OpenAI for script generation
  - ElevenLabs for text-to-speech
  
## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
4. Run locally: `netlify dev`

## Environment Variables

Create a `.env` file in the root directory with the following:

```
SUPABASE_URL=your-supabase-url
SUPABASE_KEY=your-supabase-anon-key
OPENAI_API_KEY=your-openai-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key