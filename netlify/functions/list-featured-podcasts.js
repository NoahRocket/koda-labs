exports.handler = async () => {
  const featuredEpisodes = [
    {
      job_id: "featured-001",
      title: "The Future of AI in Research",
      created_at: "2024-08-07T10:00:00Z",
      audio_url: "https://<your-supabase-url>/storage/v1/object/public/featured-podcasts/the-future-of-ai.mp3",
      duration_seconds: 312,
      concepts: [{ concept: "AI", explanation: "Artificial Intelligence is a branch of computer science that deals with the creation of intelligent agents, which are systems that can reason, learn, and act autonomously." }, { concept: "Machine Learning", explanation: "Machine learning is a subset of artificial intelligence (AI) that provides systems the ability to automatically learn and improve from experience without being explicitly programmed." }],
      status: "completed"
    },
    {
      job_id: "featured-002",
      title: "The Psychology of Creativity",
      created_at: "2024-08-07T10:00:00Z",
      audio_url: "https://<your-supabase-url>/storage/v1/object/public/featured-podcasts/the-psychology-of-creativity.mp3",
      duration_seconds: 451,
      concepts: [{ concept: "Creativity", explanation: "Creativity is a phenomenon whereby something new and somehow valuable is formed. The created item may be intangible (such as an idea, a scientific theory, a musical composition, or a joke) or a physical object (such as an invention, a literary work, or a painting)." }, { concept: "Divergent Thinking", explanation: "Divergent thinking is a thought process or method used to generate creative ideas by exploring many possible solutions. It is often used in conjunction with convergent thinking, which follows a particular set of logical steps to arrive at one solution, which in some cases is a 'correct' solution." }],
      status: "completed"
    },
    {
      job_id: "featured-003",
      title: "Breakthroughs in Biotechnology",
      created_at: "2024-08-07T10:00:00Z",
      audio_url: "https://<your-supabase-url>/storage/v1/object/public/featured-podcasts/breakthroughs-in-biotech.mp3",
      duration_seconds: 520,
      concepts: [{ concept: "Biotechnology", explanation: "Biotechnology is the broad area of biology involving living systems and organisms to develop or make products, or 'any technological application that uses biological systems, living organisms, or derivatives thereof, to make or modify products or processes for specific use' (UN Convention on Biological Diversity)." }, { concept: "CRISPR", explanation: "CRISPR is a family of DNA sequences found in the genomes of prokaryotic organisms such as bacteria and archaea. These sequences are derived from DNA fragments of bacteriophages that had previously infected the prokaryote and are used to detect and destroy DNA from similar bacteriophages during subsequent infections." }],
      status: "completed"
    }
  ];

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ podcasts: featuredEpisodes }),
  };
};
