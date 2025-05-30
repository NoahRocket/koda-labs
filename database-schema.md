# Koda Labs Database Schema Documentation

This document provides a detailed description of the Koda Labs database schema, including tables, fields, and relationships.

## Overview

Koda Labs database is structured to support several key features:
- User management and authentication
- Subscription management and payment processing
- Topic organization 
- Content creation and storage (conversations, notes, summaries)
- Bookmarking functionality
- Podcast generation and management

## Tables

### auth.users
This appears to be the core user table from Supabase Authentication.
- `id`: Primary key, UUID format
- Relationships: Referenced by multiple tables as `user_id` foreign keys

### topics
Represents topics/categories for organizing content.
- `id`: Primary key, UUID format
- `user_id`: Foreign key to `auth.users.id`
- `name`: Text field storing the topic name

### conversations
Stores chat conversations.
- `id`: Primary key, UUID format
- `topic_id`: Foreign key to `topics.id`
- `content`: Text field storing the conversation content
- `created_at`: Timestamp when the conversation was created
- `auth.users.id`: Foreign key relationship to user who owns the conversation

### summaries
Stores summaries of content.
- `id`: Primary key, UUID format
- `topic_id`: Foreign key to `topics.id`
- `user_id`: Foreign key to `auth.users.id`
- `content`: Text field storing the summary content
- `created_at`: Timestamp
- `last_source_updated_at`: Timestamp tracking when the source was last updated

### notes
Stores user notes.
- `id`: Primary key, UUID format
- `user_id`: Foreign key to `auth.users.id`
- `title`: Text field for note title
- `topic_id`: Foreign key to `topics.id`
- `content`: Text field storing the note content
- `created_at`: Timestamp when the note was created

### bookmarks
Stores bookmarked URLs or resources.
- `id`: Primary key, UUID format
- `topic_id`: Foreign key to `topics.id`
- `url`: Text field storing the bookmarked URL
- `created_at`: Timestamp when the bookmark was created

### podcasts
Stores information about generated podcasts.
- `id`: Primary key, UUID format
- `description`: Text field describing the podcast
- `created_at`: Timestamp when the podcast was created
- `user_id`: Foreign key to `auth.users.id`
- `mp3_url`: Text field storing the URL to the MP3 file
- `original_filename`: Text field storing the original filename

### podcast_jobs
Manages the podcast generation process.
- `job_id`: Primary key, UUID format
- `user_id`: Foreign key to `auth.users.id`
- `status`: Text field indicating the current status of the job
- `podcast_url`: Text field storing the URL to the final podcast
- `filename`: Text field storing the filename
- `error_message`: Text field for error messages if job fails
- `created_at`: Timestamp when the job was created
- `updated_at`: Timestamp when the job was last updated
- `concepts`: JSON field storing extracted concepts from the source

### user_subscriptions
Stores user subscription information.
- `id`: Primary key, UUID format
- `user_id`: Foreign key to `auth.users.id`
- `stripe_customer_id`: Text field storing the Stripe customer ID
- `stripe_subscription_id`: Text field storing the Stripe subscription ID
- `subscription_status`: Text field indicating the status of the subscription (active, canceled, etc.)
- `subscription_tier`: Text field indicating the subscription tier (free, premium)
- `trial_end_date`: Timestamp indicating when the trial period ends
- `created_at`: Timestamp when the subscription record was created
- `updated_at`: Timestamp when the subscription record was last updated
- `current_period_end`: Timestamp indicating when the current billing period ends
- `cancel_at_period_end`: Boolean indicating if the subscription will cancel at the end of the current period
- `billing_interval`: Text field indicating the billing interval (monthly, yearly)

## Relationships

1. Users (auth.users) can have multiple:
   - Topics
   - Conversations
   - Summaries
   - Notes
   - Podcasts
   - Podcast jobs
   - Subscription records (one active subscription at a time)

2. Topics can have multiple:
   - Conversations
   - Summaries
   - Notes
   - Bookmarks

## Feature Context

### Subscription System
The database supports the subscription system with:
- `user_subscriptions` table to track subscription status, tier, and billing information
- Integration with Stripe for payment processing and subscription management
- Support for both monthly and yearly billing intervals

### PDF to Podcast Feature
The database supports the PDF to Podcast feature with:
- `podcasts` table to store the final podcasts
- `podcast_jobs` table to track the processing pipeline (uploading, text extraction, script generation, text-to-speech conversion)

### Chat & Conversation Saving
The database supports saving conversations to topics:
- `conversations` table links to specific topics
- Users can organize their chats under different topics

## Notes for Implementation

When implementing new features:
1. Respect the existing user-topic-content hierarchy
2. For long-running processes, follow the job-based pattern used in podcast generation
3. For new content types, consider following the pattern of having a reference to both user_id and topic_id
4. All content tables include created_at timestamps for chronological tracking
