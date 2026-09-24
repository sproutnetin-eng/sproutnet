'use strict';

const TECH_KEYWORDS = {
  ai: 3, 'machine learning': 3, 'deep learning': 3, 'neural network': 3,
  blockchain: 3, 'smart contract': 3, distributed: 2.5, 'real-time': 2,
  embedded: 3, iot: 2, 'computer vision': 3, nlp: 3, 'natural language': 3,
  cloud: 1.5, microservices: 2, docker: 1.5, kubernetes: 2, scalable: 2,
  'high-performance': 2.5, concurrent: 2, parallel: 2, encryption: 2,
  cryptography: 2.5, recommendation: 1.5, 'data pipeline': 2, streaming: 2,
  websocket: 1.5, graphql: 1, 'edge computing': 3, hadoop: 2, spark: 2,
  tensorflow: 2, pytorch: 2, 'reinforcement learning': 3, 'knowledge graph': 2,
  'data processing': 1.5, mapreduce: 2, 'distributed ledger': 2.5,
  chatbot: 1.5, 'image processing': 2, 'signal processing': 2.5,
  autonomous: 3, robotics: 3,
};

const IMPLEMENTATION_KEYWORDS = {
  'web application': 1, 'mobile app': 1.5, dashboard: 1, 'data pipeline': 1.5,
  'full stack': 1.5, frontend: 1, backend: 1, database: 1, api: 1,
  authentication: 1.5, authorization: 1.5, deployment: 1, ci: 1, cd: 1,
  monitoring: 1.5, logging: 1, notification: 1, 'file upload': 1,
  'real-time': 1.5, websocket: 1, 'third-party': 1.5, integration: 1.5,
  oauth: 1.5, sso: 1.5, 'payment gateway': 2, 'sms gateway': 1.5,
  email: 1, 'push notification': 1.5, responsive: 0.5, pwa: 1,
  offline: 1.5, sync: 1.5, 'data visualization': 1.5, map: 1,
  geolocation: 1.5, 'role-based': 1, 'access control': 1.5,
  pipeline: 1, workflow: 1, 'etl': 1.5, 'data warehouse': 2,
  'data lake': 2, 'data migration': 1.5, 'data modeling': 1.5,
};

const RESEARCH_KEYWORDS = {
  research: 2, investigate: 1.5, explore: 1, study: 1, analyze: 1,
  survey: 1, literature: 2, experiment: 2, prototype: 1, feasibility: 1,
  'state of the art': 2, 'novel approach': 2, 'proof of concept': 1.5,
  'pilot study': 2, evaluation: 1, benchmark: 2, comparative: 1.5,
  methodology: 1, 'data collection': 1.5, 'field study': 2.5,
};

const TESTING_KEYWORDS = {
  test: 1, 'unit test': 1.5, integration: 1, e2e: 1.5, 'end-to-end': 1.5,
  qa: 1.5, validation: 1, verification: 1.5, 'edge case': 1.5,
  regression: 1.5, 'security testing': 2, 'performance testing': 2,
  'load testing': 2, 'stress testing': 2, 'user acceptance': 1.5,
  debugging: 1, 'fault tolerance': 2, reliability: 1.5,
};

const DOMAIN_KNOWLEDGE_MAP = {
  'AI & Data': 3,
  Climate: 2.5,
  Healthcare: 4,
  'Public Infrastructure': 2.5,
  Agriculture: 3,
  Education: 2,
  'Urban Mobility': 2,
  'Civic Technology': 2,
};

const DOMAIN_SKILLS = {
  'AI & Data': ['Machine Learning', 'Data Analysis', 'Python', 'Statistics'],
  Climate: ['Environmental Science', 'Data Analysis', 'Climate Modeling'],
  Healthcare: ['Medical Domain Knowledge', 'Healthcare Compliance', 'Data Privacy'],
  'Public Infrastructure': ['Urban Planning', 'Civil Engineering', 'Public Policy'],
  Agriculture: ['Agricultural Science', 'Supply Chain', 'Rural Technology'],
  Education: ['Educational Technology', 'Curriculum Design', 'Content Management'],
  'Urban Mobility': ['Transportation Engineering', 'GIS', 'Urban Planning'],
  'Civic Technology': ['Public Administration', 'Policy Analysis', 'Community Engagement'],
};

function countKeywords(text, keywords) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const [kw, weight] of Object.entries(keywords)) {
    if (lower.includes(kw)) {
      score += weight;
    }
  }
  return score;
}

function estimateTextComplexity(text) {
  if (!text || text.trim().length === 0) return 0;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) return 0;
  const words = text.split(/\s+/).length;
  if (words < 20) return 1;
  if (words < 50) return 3;
  if (words < 100) return 5;
  if (words < 200) return 7;
  return 9;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hoursToWeeks(hours) {
  const weeks = Math.round(hours / 40 * 10) / 10;
  return Math.max(1, Math.ceil(weeks));
}

function extractSkills(text) {
  const skills = new Set();

  const skillPatterns = [
    [/\bpython\b/i, 'Python'],
    [/\bjavascript\b/i, 'JavaScript'],
    [/\btypescript\b/i, 'TypeScript'],
    [/\bjava\b/i, 'Java'],
    [/\bgolang\b/i, 'Go'],
    [/\brust\b/i, 'Rust'],
    [/\bc(\+\+|\s+\+\+)\b/i, 'C++'],
    [/\bc#\b/i, 'C#'],
    [/\br\b(?=\s|\.|,|$)/i, 'R'],
    [/\bmatlab\b/i, 'MATLAB'],
    [/\bsql\b/i, 'SQL'],
    [/\bno?sql\b/i, 'NoSQL'],
    [/\bpostgres(ql)?\b/i, 'PostgreSQL'],
    [/\bmongo(db)?\b/i, 'MongoDB'],
    [/\bredis\b/i, 'Redis'],
    [/\bmysql\b/i, 'MySQL'],
    [/\breact\b/i, 'React'],
    [/\bnext\.?js\b/i, 'Next.js'],
    [/\bnode\.?js\b/i, 'Node.js'],
    [/\bdjango\b/i, 'Django'],
    [/\bflask\b/i, 'Flask'],
    [/\bfastapi\b/i, 'FastAPI'],
    [/\bspring\b/i, 'Spring'],
    [/\bfirebase\b/i, 'Firebase'],
    [/\baws\b/i, 'AWS'],
    [/\bazure\b/i, 'Azure'],
    [/\bgcp\b/i, 'Google Cloud'],
    [/\bdocker\b/i, 'Docker'],
    [/\bkubernetes\b/i, 'Kubernetes'],
    [/\btensorflow\b/i, 'TensorFlow'],
    [/\bpytorch\b/i, 'PyTorch'],
    [/\bapi\b/i, 'API Development'],
    [/\bgis\b/i, 'GIS'],
    [/\biot\b/i, 'IoT'],
    [/\bml|machine learning\b/i, 'Machine Learning'],
    [/\bdl|deep learning\b/i, 'Deep Learning'],
    [/\bnlp\b/i, 'NLP'],
    [/\bdatabase\b/i, 'Database Management'],
    [/\bcloud\b/i, 'Cloud Computing'],
    [/\bmobile\sapp\b/i, 'Mobile Development'],
    [/\bflutter\b/i, 'Flutter'],
    [/\breact\s+native\b/i, 'React Native'],
    [/\bandroid\b/i, 'Android Development'],
    [/\bios\b(?=\s|,|\.)/i, 'iOS Development'],
    [/\bdata\s+analysis\b/i, 'Data Analysis'],
    [/\bdata\s+science\b/i, 'Data Science'],
    [/\bcyber\s+security\b/i, 'Cybersecurity'],
    [/\bsecurity\b(?=.*test|.*audit|.*vuln)/i, 'Cybersecurity'],
    [/\bdevops\b/i, 'DevOps'],
    [/\bui\s*\/?\s*ux\b/i, 'UI/UX Design'],
    [/\bgis\b/i, 'GIS'],
    [/\bblockchain\b/i, 'Blockchain'],
    [/\bcomputer\s+vision\b/i, 'Computer Vision'],
    [/\bembedded\b/i, 'Embedded Systems'],
    [/\brobotics\b/i, 'Robotics'],
  ];

  for (const [pattern, skill] of skillPatterns) {
    if (pattern.test(text)) {
      skills.add(skill);
    }
  }

  return Array.from(skills).slice(0, 8);
}

function detectTags(text, domain) {
  const tags = new Set();
  const lower = text.toLowerCase();

  tags.add(domain);

  const tagPatterns = [
    [/\bweb\b/i, 'Web'],
    [/\bmobile\b/i, 'Mobile'],
    [/\bdata\b/i, 'Data'],
    [/\bai\b|machine learning|deep learning/i, 'AI'],
    [/\bapi\b/i, 'API'],
    [/\bdatabase\b/i, 'Database'],
    [/\bsecurity\b/i, 'Security'],
    [/\breal\s*\-?\s*time\b/i, 'Real-time'],
    [/\banalytics\b/i, 'Analytics'],
    [/\bcloud\b/i, 'Cloud'],
    [/\biot\b/i, 'IoT'],
    [/\bautomation\b/i, 'Automation'],
    [/\bplatform\b/i, 'Platform'],
    [/\btool\b/i, 'Tooling'],
    [/\bmonitoring\b/i, 'Monitoring'],
    [/\boptimization\b/i, 'Optimization'],
    [/\bvisualization\b/i, 'Visualization'],
    [/\bcollaboration\b|team/i, 'Collaboration'],
    [/\bhealth\b|medical|clinical/i, 'Healthcare'],
    [/\beducation\b|learning/i, 'Education'],
    [/\bagriculture\b|farm(ing)?/i, 'Agriculture'],
    [/\bclimate\b|environment|sustain/i, 'Environment'],
    [/\btransport(ation)?\b|mobility/i, 'Transportation'],
    [/\bgovern(ment|ance)\b|civic/i, 'Civic'],
  ];

  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(lower)) {
      tags.add(tag);
    }
  }

  return Array.from(tags).slice(0, 6);
}

function evaluateProblem(input) {
  const allText = [
    input.title,
    input.context,
    input.problem_stmt,
    input.scope,
    input.constraints,
    input.deliverables,
  ].filter(Boolean).join(' ');

  const lowerAll = allText.toLowerCase();

  const techScore = countKeywords(lowerAll, TECH_KEYWORDS);
  const implScore = countKeywords(lowerAll, IMPLEMENTATION_KEYWORDS);
  const researchScore = countKeywords(lowerAll, RESEARCH_KEYWORDS);
  const testScore = countKeywords(lowerAll, TESTING_KEYWORDS);

  const textComplexity = estimateTextComplexity(allText);

  const technical_complexity = clamp(
    techScore * 1.2 + textComplexity * 0.3 + (input.domain === 'AI & Data' ? 2 : 0),
    0, 10
  );

  const implementation_complexity = clamp(
    implScore * 0.8 + textComplexity * 0.2 +
      (input.milestones > 1 ? input.milestones * 0.5 : 0),
    0, 10
  );

  const wordCount = allText.split(/\s+/).length;
  const milestoneEffort = input.milestones * 5;
  const baseEffort = wordCount > 500 ? 40 : wordCount > 200 ? 24 : 16;
  const deadlineDays = input.deadline
    ? Math.max(1, Math.ceil((new Date(input.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 30;
  const deadlineIntensity = deadlineDays < 7 ? 1.5 : deadlineDays < 21 ? 1.2 : 1.0;

  const rawHours = Math.round((baseEffort + milestoneEffort) * deadlineIntensity);
  const estimated_hours = clamp(rawHours, 4, 500);

  const engineering_effort = clamp(
    (estimated_hours / 50) + (input.milestones * 0.8) + textComplexity * 0.2,
    0, 10
  );

  const research_complexity = clamp(
    researchScore * 0.8 + (allText.includes('uncertain') ? 1.5 : 0) +
      (allText.includes('open-ended') ? 1 : 0),
    0, 10
  );

  const testing_complexity = clamp(
    testScore * 0.7 + (input.constraints?.toLowerCase().includes('reliability') ? 2 : 0) +
      (input.constraints?.toLowerCase().includes('accuracy') ? 1.5 : 0),
    0, 10
  );

  const domain_base = DOMAIN_KNOWLEDGE_MAP[input.domain] ?? 2;
  const domainMedical = allText.match(/medical|clinical|patient|diagnos|pharma/i) ? 2 : 0;
  const domainFinance = allText.match(/financial|payment|banking|transaction/i) ? 2 : 0;
  const domainLegal = allText.match(/legal|regulation|compliance|policy|govern/i) ? 2 : 0;

  const domain_knowledge = clamp(domain_base + domainMedical + domainFinance + domainLegal, 0, 10);

  const isTeamMode = input.team_mode === 'team' || input.team_mode === 'both';
  const teamSize = (input.max_team_size ?? 1);
  const collaboration_requirement = clamp(
    (isTeamMode ? 3 : 0) + (teamSize > 2 ? teamSize * 0.8 : 0) +
      (input.mentor_required ? 1.5 : 0),
    0, 10
  );

  const hasNovelty = allText.match(/novel|innovative|creative|new approach|reimagine/i) ? 2 : 0;
  const openEnded = input.problem_stmt?.length > 200 ? 1 : 0;
  const specificConstraints = input.constraints?.length > 100 ? -1 : 0;
  const innovation_requirement = clamp(
    hasNovelty + openEnded + specificConstraints +
      (input.problem_type === 'industry_challenge' ? 1 : 0.5),
    0, 10
  );

  const weights = {
    technical_complexity: 0.25,
    implementation_complexity: 0.20,
    engineering_effort: 0.15,
    research_complexity: 0.10,
    testing_complexity: 0.10,
    domain_knowledge: 0.10,
    collaboration_requirement: 0.05,
    innovation_requirement: 0.05,
  };

  const difficulty_score = clamp(
    technical_complexity * weights.technical_complexity +
    implementation_complexity * weights.implementation_complexity +
    engineering_effort * weights.engineering_effort +
    research_complexity * weights.research_complexity +
    testing_complexity * weights.testing_complexity +
    domain_knowledge * weights.domain_knowledge +
    collaboration_requirement * weights.collaboration_requirement +
    innovation_requirement * weights.innovation_requirement,
    0, 10
  );

  const roundedScore = Math.round(difficulty_score * 10) / 10;

  let difficulty;
  let leaderboard_weight;

  if (roundedScore <= 2.5) {
    difficulty = 'Beginner';
    leaderboard_weight = 1.0;
  } else if (roundedScore <= 5.0) {
    difficulty = 'Intermediate';
    leaderboard_weight = 1.5;
  } else if (roundedScore <= 7.5) {
    difficulty = 'Advanced';
    leaderboard_weight = 2.2;
  } else {
    difficulty = 'Expert';
    leaderboard_weight = 3.0;
  }

  const impactCriteria = [
    allText.includes('community') || allText.includes('public') || allText.includes('citizen') ? 2 : 0,
    allText.includes('farmer') || allText.includes('student') || allText.includes('patient') || allText.includes('rural') ? 2 : 0,
    input.problem_type === 'industry_challenge' ? 2 : 1,
    allText.match(/scale|widespread|national|state|city|urban|large/i) ? 1.5 : 0,
    allText.includes('cost') || allText.includes('revenue') || allText.includes('efficiency') ? 1 : 0,
    allText.match(/social|environment|sustain|welfare/i) ? 1.5 : 0,
  ];

  const impact_score = clamp(
    impactCriteria.reduce((a, b) => a + b, 0) + textComplexity * 0.2,
    0, 10
  );

  const skills = extractSkills(allText);
  if (skills.length === 0) {
    const domainSkills = DOMAIN_SKILLS[input.domain];
    if (domainSkills) {
      skills.push(...domainSkills.slice(0, 4));
    }
    if (skills.length === 0) {
      skills.push('Analytical Thinking', 'Problem Solving', 'Research');
    }
  }

  const tags = detectTags(allText, input.domain);

  const riskFactors = [];
  if (technical_complexity > 7) riskFactors.push('high technical complexity');
  if (domain_knowledge > 7) riskFactors.push('specialized domain knowledge required');
  if (estimated_hours > 200) riskFactors.push('large time commitment');
  if (input.mentor_required) riskFactors.push('mentor-dependent');
  if (collaboration_requirement > 5 && teamSize < 2) riskFactors.push('team coordination risk');

  const riskLevel =
    riskFactors.length >= 3 ? 'High' :
    riskFactors.length >= 1 ? 'Medium' :
    'Low';

  const strengths = [];
  if (input.domain === 'AI & Data' || allText.includes('data-driven')) strengths.push('Data-driven approach');
  if (impact_score > 6) strengths.push('High potential impact');
  if (technical_complexity < 4) strengths.push('Accessible to beginners');
  if (domain_knowledge >= 4 && domain_knowledge <= 6) strengths.push('Interdisciplinary learning opportunity');
  if (input.problem_type === 'public_impact') strengths.push('Real-world social impact');
  if (input.milestones <= 2) strengths.push('Clear scope with manageable milestones');
  if (innovation_requirement > 4) strengths.push('Encourages creative/innovative thinking');
  if (research_complexity < 4) strengths.push('Implementation-focused with clear requirements');

  const weaknesses = [];
  if (technical_complexity > 7) weaknesses.push('Requires advanced technical expertise');
  if (research_complexity > 6) weaknesses.push('Significant research/uncertainty involved');
  if (domain_knowledge > 6) weaknesses.push('Requires specialized domain expertise');
  if (estimated_hours > 160) weaknesses.push('Large time commitment required');
  if (testing_complexity > 6) weaknesses.push('Complex testing and validation requirements');
  if (collaboration_requirement > 5 && teamSize > 3) weaknesses.push('Requires large team coordination');

  const reasoning = [
    `Technical analysis based on ${wordCount} words of problem description`,
    `Technical complexity rated ${technical_complexity.toFixed(1)}/10 — ${techScore >= 5 ? 'significant technical infrastructure needed' : techScore >= 2 ? 'moderate technical requirements' : 'minimal technical dependencies'}`,
    `Engineering effort estimated at ${estimated_hours} hours across ${input.milestones} milestone${input.milestones > 1 ? 's' : ''}`,
    `Domain knowledge in ${input.domain} ${domain_knowledge >= 6 ? 'requires significant expertise' : 'is approachable with basic familiarity'}`,
    `Difficulty score ${roundedScore}/10 → ${difficulty} (leaderboard weight ×${leaderboard_weight})`,
    `Impact scored at ${impact_score.toFixed(1)}/10 based on ${input.problem_type === 'industry_challenge' ? 'industry relevance and business value' : 'public benefit and social relevance'}`,
  ];

  const estimated_weeks = hoursToWeeks(estimated_hours);

  return {
    difficulty,
    difficulty_score: roundedScore,
    leaderboard_weight,
    impact_score: Math.round(impact_score * 10) / 10,
    confidence: 0.7,
    estimated_hours: Math.round(estimated_hours),
    estimated_weeks,
    recommended_team_size: {
      minimum: input.min_team_size ?? 1,
      maximum: input.max_team_size ?? 4,
    },
    weighted_breakdown: {
      technical_complexity: Math.round(technical_complexity * 10) / 10,
      implementation_complexity: Math.round(implementation_complexity * 10) / 10,
      engineering_effort: Math.round(engineering_effort * 10) / 10,
      research_complexity: Math.round(research_complexity * 10) / 10,
      testing_complexity: Math.round(testing_complexity * 10) / 10,
      domain_knowledge: Math.round(domain_knowledge * 10) / 10,
      collaboration_requirement: Math.round(collaboration_requirement * 10) / 10,
      innovation_requirement: Math.round(innovation_requirement * 10) / 10,
    },
    skills_required: skills,
    problem_tags: tags,
    risk_level: riskLevel,
    strengths: strengths.slice(0, 5),
    weaknesses: weaknesses.slice(0, 4),
    reasoning: reasoning,
  };
}

module.exports = {
  evaluateProblem,
};
