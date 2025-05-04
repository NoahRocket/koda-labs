# Koda Labs

Koda Compass is a personal knowledge companion that helps users learn, remember, and organize information effectively through AI assistance and knowledge management tools.

## Features

- **AI Chat Interface**: Converse with an AI assistant to explore and learn new topics.
- **Dashboard**: Central hub for accessing all your saved knowledge.
- **Topic Management**: Organize saved content by topic for better retrieval.
- **Bookmarks**: Save and organize web links and important information.
- **PDF to Podcast**: Convert PDFs to audio podcasts for on-the-go learning.

## PDF to Podcast Feature

The PDF to Podcast feature transforms uploaded PDF documents into engaging audio podcasts through the following pipeline:

1. **PDF Upload**: Users upload PDFs containing text they want to convert.
2. **Concept Extraction**: The system extracts key concepts and explanations from the text.
3. **Script Generation**: Using OpenAI's API, the system creates a conversational podcast script.
4. **Text-to-Speech**: The script is converted to natural-sounding speech using ElevenLabs' API.
5. **Storage & Playback**: The generated MP3 is stored in Supabase Storage and made available for playback and download.

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