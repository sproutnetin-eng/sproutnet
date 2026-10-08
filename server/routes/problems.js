const express = require('express');
const router = express.Router();

const { authRequired, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');
const upload = require('../middleware/upload');

// Shared thumbnail helpers (same named exports as lib/problem-thumbnail.ts).
// Falls back to an inlined port when server/lib/problem-thumbnail.js is absent.
let ThumbnailLib;
try {
  ThumbnailLib = require('../lib/problem-thumbnail');
} catch (e) {
  ThumbnailLib = {
    PROBLEM_THUMBNAIL_BUCKET: 'problem-thumbnails',
    PROBLEM_THUMBNAIL_MAX_BYTES: 5 * 1024 * 1024,
    PROBLEM_THUMBNAIL_ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    getProblemThumbnailError(file) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
        return 'Use a JPG, PNG, WebP, or GIF image for the thumbnail.';
      }
      if (file.size > 5 * 1024 * 1024) {
        return 'Thumbnail image must be 5 MB or smaller.';
      }
      return null;
    },
    normalizeProblemThumbnailUrl(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.toString();
      } catch (err) {
        return null;
      }
    },
    sanitizeProblemThumbnailFileName(name) {
      const lastDot = name.lastIndexOf('.');
      const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'thumbnail';
      const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'jpg')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 8) || 'jpg';
      return `${base}.${extension}`;
    },
    encodeProblemThumbnailFallback(url) {
      if (!url) return null;
      return `thumbnail::${url}`;
    },
    decodeProblemThumbnailFallback(value) {
      if (typeof value !== 'string') return null;
      if (!value.startsWith('thumbnail::')) return null;
      const url = value.slice('thumbnail::'.length).trim();
      if (typeof url !== 'string') return null;
      const trimmed = url.trim();
      if (!trimmed) return null;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString();
      } catch (err) {
        return null;
      }
    },
    isMissingProblemThumbnailColumnError(message) {
      if (!message) return false;
      const normalized = message.toLowerCase();
      return (
        normalized.includes('thumbnail_url') &&
        (
          normalized.includes('schema cache') ||
          normalized.includes('does not exist') ||
          normalized.includes('unknown column')
        )
      );
    },
  };
}

const {
  PROBLEM_THUMBNAIL_BUCKET,
  PROBLEM_THUMBNAIL_MAX_BYTES,
  PROBLEM_THUMBNAIL_ALLOWED_TYPES,
  getProblemThumbnailError,
  normalizeProblemThumbnailUrl,
  sanitizeProblemThumbnailFileName,
  encodeProblemThumbnailFallback,
  decodeProblemThumbnailFallback,
  isMissingProblemThumbnailColumnError,
} = ThumbnailLib;

// ---- Problem evaluator (port of lib/problem-evaluator.ts + lib/ai-evaluator.ts) ----

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are an expert software architect and engineering manager. Your job is to analyze engineering problems and return a JSON evaluation.

Evaluate the problem across these 8 weighted criteria (each 0-10):
- technical_complexity (weight 0.25): Architecture, algorithms, integrations, scaling, AI, security
- implementation_complexity (weight 0.20): Frontend, backend, APIs, deployment, infra
- engineering_effort (weight 0.15): Hours of work, milestones, scope
- research_complexity (weight 0.10): Documentation, experimentation, uncertainty
- testing_complexity (weight 0.10): QA, debugging, edge cases
- domain_knowledge (weight 0.10): Specialized expertise required
- collaboration_requirement (weight 0.05): Teamwork necessity
- innovation_requirement (weight 0.05): Original thinking vs straightforward impl

Return ONLY valid JSON with this exact schema:
{
  "difficulty": "Beginner | Intermediate | Advanced | Expert",
  "difficulty_score": 0-10,
  "leaderboard_weight": 1.0 | 1.5 | 2.2 | 3.0,
  "impact_score": 0-10,
  "confidence": 0-1,
  "estimated_hours": integer,
  "estimated_weeks": integer,
  "recommended_team_size": { "minimum": 1, "maximum": 4 },
  "weighted_breakdown": {
    "technical_complexity": number,
    "implementation_complexity": number,
    "engineering_effort": number,
    "research_complexity": number,
    "testing_complexity": number,
    "domain_knowledge": number,
    "collaboration_requirement": number,
    "innovation_requirement": number
  },
  "skills_required": ["skill1", "skill2"],
  "problem_tags": ["tag1", "tag2"],
  "risk_level": "Low | Medium | High",
  "strengths": ["strength1"],
  "weaknesses": ["weakness1"],
  "reasoning": ["reason1", "reason2"]
}

Difficulty mapping:
- 0-2.5: Beginner (weight 1.0)
- 2.6-5.0: Intermediate (weight 1.5)
- 5.1-7.5: Advanced (weight 2.2)
- 7.6-10.0: Expert (weight 3.0)

Rules:
- Base difficulty on engineering effort, not popularity
- Evaluate impact separately from difficulty
- Be objective and unbiased
- Lower confidence if info is missing
- Never return markdown or extra text`;

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
  pipeline: 1, workflow: 1, etl: 1.5, 'data warehouse': 2,
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
    if (lower.includes(kw)) score += weight;
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

function clampEval(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hoursToWeeks(hours) {
  const weeks = Math.round((hours / 40) * 10) / 10;
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
    if (pattern.test(text)) skills.add(skill);
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
    if (pattern.test(lower)) tags.add(tag);
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

  const technical_complexity = clampEval(
    techScore * 1.2 + textComplexity * 0.3 + (input.domain === 'AI & Data' ? 2 : 0),
    0, 10
  );

  const implementation_complexity = clampEval(
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
  const estimated_hours = clampEval(rawHours, 4, 500);

  const engineering_effort = clampEval(
    (estimated_hours / 50) + (input.milestones * 0.8) + textComplexity * 0.2,
    0, 10
  );

  const research_complexity = clampEval(
    researchScore * 0.8 + (allText.includes('uncertain') ? 1.5 : 0) +
      (allText.includes('open-ended') ? 1 : 0),
    0, 10
  );

  const testing_complexity = clampEval(
    testScore * 0.7 + (input.constraints?.toLowerCase().includes('reliability') ? 2 : 0) +
      (input.constraints?.toLowerCase().includes('accuracy') ? 1.5 : 0),
    0, 10
  );

  const domain_base = DOMAIN_KNOWLEDGE_MAP[input.domain] ?? 2;
  const domainMedical = allText.match(/medical|clinical|patient|diagnos|pharma/i) ? 2 : 0;
  const domainFinance = allText.match(/financial|payment|banking|transaction/i) ? 2 : 0;
  const domainLegal = allText.match(/legal|regulation|compliance|policy|govern/i) ? 2 : 0;

  const domain_knowledge = clampEval(domain_base + domainMedical + domainFinance + domainLegal, 0, 10);

  const isTeamMode = input.team_mode === 'team' || input.team_mode === 'both';
  const teamSize = (input.max_team_size ?? 1);
  const collaboration_requirement = clampEval(
    (isTeamMode ? 3 : 0) + (teamSize > 2 ? teamSize * 0.8 : 0) +
      (input.mentor_required ? 1.5 : 0),
    0, 10
  );

  const hasNovelty = allText.match(/novel|innovative|creative|new approach|reimagine/i) ? 2 : 0;
  const openEnded = input.problem_stmt?.length > 200 ? 1 : 0;
  const specificConstraints = input.constraints?.length > 100 ? -1 : 0;
  const innovation_requirement = clampEval(
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

  const difficulty_score = clampEval(
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

  const impact_score = clampEval(
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
    reasoning,
  };
}

function buildPrompt(input) {
  return `Evaluate this engineering problem:

Title: ${input.title}
Domain: ${input.domain}
Type: ${input.problem_type}
Context: ${input.context}
Problem Statement: ${input.problem_stmt}
Scope: ${input.scope}
Constraints: ${input.constraints}
Deliverables: ${input.deliverables}
Milestones: ${input.milestones}
Deadline: ${input.deadline ? new Date(input.deadline).toISOString().split('T')[0] : 'Not specified'}
Team Mode: ${input.team_mode ?? 'solo'}
Team Size: ${input.min_team_size ?? 1} - ${input.max_team_size ?? 4}
Mentor Required: ${input.mentor_required ?? false}`;
}

async function callGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error('Groq API error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error('Groq API call failed:', err);
    return null;
  }
}

function validateDifficulty(val) {
  if (val === 'Beginner' || val === 'Intermediate' || val === 'Advanced' || val === 'Expert') {
    return val;
  }
  return 'Intermediate';
}

function validateWeight(score) {
  if (score <= 2.5) return 1.0;
  if (score <= 5.0) return 1.5;
  if (score <= 7.5) return 2.2;
  return 3.0;
}

function validateRisk(val) {
  if (val === 'Low' || val === 'Medium' || val === 'High') return val;
  return 'Medium';
}

async function evaluateProblemWithAI(input) {
  const prompt = buildPrompt(input);
  const content = await callGroq(prompt);

  if (!content) {
    console.warn('AI evaluator unavailable, falling back to deterministic');
    return evaluateProblem(input);
  }

  try {
    const parsed = JSON.parse(content);

    const normalized = {
      difficulty: validateDifficulty(parsed.difficulty),
      difficulty_score: clampEval(Number(parsed.difficulty_score) || 5, 0, 10),
      leaderboard_weight: validateWeight(parsed.difficulty_score ?? 5),
      impact_score: clampEval(Number(parsed.impact_score) || 5, 0, 10),
      confidence: clampEval(Number(parsed.confidence) || 0.5, 0, 1),
      estimated_hours: Math.round(Number(parsed.estimated_hours) || 40),
      estimated_weeks: Math.round(Number(parsed.estimated_weeks) || 2),
      recommended_team_size: {
        minimum: Math.max(1, Math.round(Number(parsed.recommended_team_size?.minimum) || 1)),
        maximum: Math.min(10, Math.round(Number(parsed.recommended_team_size?.maximum) || 4)),
      },
      weighted_breakdown: {
        technical_complexity: clampEval(Number(parsed.weighted_breakdown?.technical_complexity) || 5, 0, 10),
        implementation_complexity: clampEval(Number(parsed.weighted_breakdown?.implementation_complexity) || 5, 0, 10),
        engineering_effort: clampEval(Number(parsed.weighted_breakdown?.engineering_effort) || 5, 0, 10),
        research_complexity: clampEval(Number(parsed.weighted_breakdown?.research_complexity) || 5, 0, 10),
        testing_complexity: clampEval(Number(parsed.weighted_breakdown?.testing_complexity) || 5, 0, 10),
        domain_knowledge: clampEval(Number(parsed.weighted_breakdown?.domain_knowledge) || 5, 0, 10),
        collaboration_requirement: clampEval(Number(parsed.weighted_breakdown?.collaboration_requirement) || 5, 0, 10),
        innovation_requirement: clampEval(Number(parsed.weighted_breakdown?.innovation_requirement) || 5, 0, 10),
      },
      skills_required: Array.isArray(parsed.skills_required) ? parsed.skills_required.slice(0, 10) : [],
      problem_tags: Array.isArray(parsed.problem_tags) ? parsed.problem_tags.slice(0, 8) : [],
      risk_level: validateRisk(parsed.risk_level),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 6) : [],
      reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning.slice(0, 8) : [],
    };

    return normalized;
  } catch (err) {
    console.error('Failed to parse AI response:', err, 'Raw:', content);
    return evaluateProblem(input);
  }
}

const TEST_PROBLEMS = [
  {
    title: 'Campus Lost & Found Platform',
    domain: 'Education',
    problem_type: 'public_impact',
    context: 'Every semester, hundreds of students lose items on campus — phones, wallets, ID cards, books, and laptops. Currently, lost items are reported verbally or through vague WhatsApp group messages that get lost in the noise. There is no centralized system to match lost items with found reports. Students waste hours searching for their belongings, and the admin office is flooded with inquiries.',
    problem_stmt: 'Design and build a web-based platform that allows students to report lost or found items on campus. The platform must automatically match lost reports with found reports based on item category, location, and date. It should notify both parties when a potential match is found. The solution should be simple enough for anyone to use without training.',
    scope: 'Build a web application with user authentication, item reporting forms, a matching algorithm, notification system, and an admin dashboard to manage reported items. The platform should be responsive and work on mobile browsers.',
    constraints: 'Must be a web-based solution (no native apps). Must handle at least 100 concurrent users. Must respect user privacy — contact info should only be revealed after a match is confirmed. Must work with minimal server resources.',
    deliverables: 'Working web application with: 1) User registration/login, 2) Report lost item form, 3) Report found item form, 4) Auto-matching engine, 5) Notification system (email/in-app), 6) Admin dashboard with moderation tools, 7) Simple search/browse interface for all items.',
    milestones: 2,
    deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    team_mode: 'solo',
    min_team_size: 1,
    max_team_size: 1,
  },
  {
    title: 'Smart Water Quality Monitoring for Rural Communities',
    domain: 'Climate',
    problem_type: 'public_impact',
    context: 'Access to clean drinking water remains a critical challenge in rural India. According to recent surveys, over 60% of rural households depend on groundwater that is contaminated with fluoride, arsenic, or nitrates. Current testing methods are expensive, slow, and require lab equipment. Communities often discover contamination only after people fall ill. There is no real-time, affordable system for continuous water quality monitoring at the community level.',
    problem_stmt: 'Design an IoT-based water quality monitoring system that can measure key parameters (pH, turbidity, TDS, temperature) in real-time, transmit data wirelessly to a cloud dashboard, and send alerts when parameters cross safe thresholds. The system must be affordable (target < ₹10,000 per unit) and operate on solar power for use in off-grid locations.',
    scope: 'The project includes hardware sensor integration, firmware development, wireless data transmission (GSM/LoRa), cloud data ingestion, a web dashboard for visualization, an alerting system (SMS/voice), and a public API for integration with government health systems.',
    constraints: 'Must use low-cost, off-the-shelf sensors. Must operate reliably in high-temperature (45°C) and high-humidity environments. Data transmission should work in areas with limited cellular coverage. The dashboard must be usable by semi-literate users with minimal training.',
    deliverables: '1) Working prototype with sensor array, 2) Firmware for data collection and transmission, 3) Cloud backend with data storage and API, 4) Web dashboard with real-time charts and maps, 5) SMS alert system for threshold breaches, 6) Deployment and maintenance guide, 7) Cost analysis and scalability report.',
    milestones: 3,
    deadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    team_mode: 'team',
    min_team_size: 2,
    max_team_size: 4,
    mentor_required: true,
  },
  {
    title: 'AI-Powered Crop Disease Detection & Advisory System',
    domain: 'Agriculture',
    problem_type: 'public_impact',
    context: 'Smallholder farmers in India lose an estimated 15-25% of their crop yield annually due to undetected plant diseases. Diagnosis is currently done by agricultural extension officers who are severely understaffed — there is only one officer per 2,000 farmers in many districts. By the time a disease is identified, it has often spread to neighboring farms. Farmers need a tool that can diagnose diseases instantly from a smartphone photo and provide treatment recommendations.',
    problem_stmt: 'Build a mobile-first system that uses computer vision to detect and classify crop diseases from smartphone photos. The system should support at least 10 major crop types and 30+ diseases. It must provide actionable treatment recommendations in the local language, with dosage information for common pesticides/fungicides. The ML model should achieve >90% accuracy and work offline after initial download.',
    scope: 'Full-stack solution including: dataset collection and annotation pipeline, CNN model training and deployment, mobile web app with camera integration, offline inference capability, treatment recommendation engine, and a feedback loop for continuous model improvement through expert verification.',
    constraints: 'Must work on budget smartphones (2GB RAM, Android 10+). Model must be under 50MB for offline use. Recommendations must follow government-approved treatment guidelines. Must support at least Kannada and English interfaces. Response time must be under 3 seconds on a 4G connection.',
    deliverables: '1) Curated dataset of 10,000+ labeled disease images, 2) Trained CNN model with >90% accuracy, 3) Mobile web app with camera-based diagnosis, 4) Treatment recommendation engine with dosage calculator, 5) Offline inference mode, 6) Expert verification dashboard for continuous learning, 7) Deployment guide for rural areas.',
    milestones: 4,
    deadline: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    team_mode: 'team',
    min_team_size: 2,
    max_team_size: 4,
    mentor_required: true,
  },
  {
    title: 'Real-Time Urban Traffic Optimization Engine',
    domain: 'Urban Mobility',
    problem_type: 'industry_challenge',
    context: 'Bengaluru, with over 8 million vehicles, consistently ranks among the most congested cities globally. Average commute speeds have dropped to 14 km/h during peak hours. Current traffic management systems use fixed-timing signals that do not adapt to real-time conditions. Multiple agencies manage different aspects of traffic independently — no unified optimization exists. A 10% improvement in traffic flow would save an estimated ₹10,000 crore annually in fuel costs and lost productivity.',
    problem_stmt: 'Design and prototype a real-time traffic optimization engine that integrates with existing traffic infrastructure. The system should use computer vision at intersections to measure vehicle density, predict congestion patterns using deep learning, and dynamically adjust signal timings to minimize average wait times. It must handle city-scale deployment with 500+ intersections and provide a dashboard for traffic authorities.',
    scope: 'The project spans: edge-based vehicle detection using existing CCTV feeds, congestion prediction model training, multi-agent reinforcement learning for signal optimization, real-time data pipeline processing 1000+ events/second, integration with existing traffic management systems, and a command center dashboard with simulation capabilities.',
    constraints: 'Must process video feeds from existing low-resolution (720p) CCTV cameras. Signal optimization decisions must be made in under 500ms. System must degrade gracefully if individual cameras or signals fail. Must comply with traffic department data retention policies. Should be deployable on existing government cloud infrastructure.',
    deliverables: '1) Vehicle detection and counting module for live CCTV feeds, 2) Congestion prediction model with 30-minute forecast capability, 3) Reinforcement learning-based signal optimization algorithm, 4) Real-time data pipeline with sub-second latency, 5) Traffic command center dashboard, 6) Simulation environment for what-if analysis, 7) API for integration with existing traffic management systems, 8) Deployment and scaling documentation.',
    milestones: 5,
    deadline: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString(),
    team_mode: 'team',
    min_team_size: 3,
    max_team_size: 5,
    mentor_required: true,
  },
];

// ---- POST /api/problems/create (port of app/api/problems/create/route.ts) ----

router.post('/api/problems/create', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const missing = [];
  const requiredText = [
    'title',
    'domain',
    'problem_type',
    'deadline',
    'judging_deadline',
    'context',
    'problem_stmt',
    'scope',
    'constraints',
    'deliverables',
  ];

  for (const key of requiredText) {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(key);
    }
  }

  const milestones = payload.milestones == null || payload.milestones === '' ? 3 : Number(payload.milestones);

  if (!Number.isInteger(milestones) || milestones < 2 || milestones > 5) {
    return res.status(422).json({ error: 'Milestones must be a whole number between 2 and 5.' });
  }

  if (
    typeof payload.deadline === 'string' &&
    typeof payload.judging_deadline === 'string' &&
    payload.judging_deadline < payload.deadline
  ) {
    return res.status(422).json(
      { error: 'Judging deadline must be on or after the submission deadline.' }
    );
  }

  if (missing.length > 0) {
    return res.status(422).json({ error: `Missing or invalid fields: ${missing.join(', ')}` });
  }

  const thumbnailUrl = payload.thumbnail_url == null
    ? null
    : normalizeProblemThumbnailUrl(payload.thumbnail_url);

  if (payload.thumbnail_url != null && !thumbnailUrl) {
    return res.status(422).json({ error: 'Invalid thumbnail_url' });
  }

  const admin = getAdmin();
  const insertData = {
    title: payload.title,
    domain: payload.domain,
    problem_type: payload.problem_type,
    status: payload.status ?? 'open',
    reward_amount: payload.reward_amount ?? null,
    thumbnail_url: thumbnailUrl,
    milestones,
    deadline: payload.deadline,
    judging_deadline: payload.judging_deadline,
    context: payload.context,
    problem_stmt: payload.problem_stmt,
    scope: payload.scope,
    constraints: payload.constraints,
    deliverables: payload.deliverables,
    poster_id: user.id,
    team_mode: payload.team_mode ?? 'solo',
    min_team_size: payload.min_team_size ?? 1,
    max_team_size: payload.max_team_size ?? 4,
    mentor_required: payload.mentor_required ?? false,
    max_mentors_per_team: payload.max_mentors_per_team ?? 1,
  };

  let warning = null;
  let insertedId = null;
  let insertError = null;

  const { data: inserted, error } = await admin
    .from('problems')
    .insert(insertData)
    .select('id')
    .single();

  if (error && isMissingProblemThumbnailColumnError(error.message)) {
    const fallbackInsertData = Object.fromEntries(
      Object.entries(insertData).filter(([key]) => key !== 'thumbnail_url')
    );
    const retryPayload = {
      ...fallbackInsertData,
      rejected_reason: encodeProblemThumbnailFallback(thumbnailUrl),
    };
    const retry = await admin.from('problems').insert(retryPayload).select('id').single();
    insertError = retry.error;
    if (!insertError && retry.data) {
      insertedId = retry.data.id;
    }

    if (!insertError && thumbnailUrl && decodeProblemThumbnailFallback(retryPayload.rejected_reason) === thumbnailUrl) {
      warning = 'Problem saved using temporary thumbnail storage because the database migration has not been applied yet.';
    }
  } else if (!error && inserted) {
    insertedId = inserted.id;
  } else {
    insertError = error;
  }

  const displayError = error && !isMissingProblemThumbnailColumnError(error.message) ? error : insertError;

  if (displayError) {
    console.error('Problem insert failed:', {
      message: displayError.message,
      code: displayError.code,
      details: displayError.details,
      hint: displayError.hint,
    });
    if (displayError.message && displayError.message.includes('problems_milestones_check')) {
      return res.status(422).json({ error: 'Milestones must be a whole number between 2 and 5.' });
    }
    return res.status(400).json(
      { error: displayError.message, code: displayError.code, details: displayError.details, hint: displayError.hint }
    );
  }

  if (insertedId) {
    try {
      const evalInput = {
        title: payload.title,
        domain: payload.domain,
        problem_type: payload.problem_type,
        context: payload.context,
        problem_stmt: payload.problem_stmt,
        scope: payload.scope,
        constraints: payload.constraints,
        deliverables: payload.deliverables,
        milestones,
        deadline: payload.deadline,
        team_mode: payload.team_mode,
        min_team_size: payload.min_team_size,
        max_team_size: payload.max_team_size,
        mentor_required: payload.mentor_required,
      };

      const evaluation = await evaluateProblemWithAI(evalInput);

      await admin
        .from('problems')
        .update({
          difficulty_score: evaluation.difficulty_score,
          difficulty_label: evaluation.difficulty,
          leaderboard_weight: evaluation.leaderboard_weight,
          impact_score: evaluation.impact_score,
          estimated_hours: evaluation.estimated_hours,
          estimated_weeks: evaluation.estimated_weeks,
          evaluation_json: evaluation,
          evaluated_at: new Date().toISOString(),
        })
        .eq('id', insertedId);
    } catch (evalErr) {
      console.error('Auto-evaluation failed:', evalErr);
    }
  }

  return res.status(200).json({ ok: true, warning, problem_id: insertedId });
});

// ---- POST /api/problems/update (port of app/api/problems/update/route.ts) ----

router.post('/api/problems/update', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!payload.id) {
    return res.status(400).json({ error: 'Missing id' });
  }

  const requiredText = [
    'title',
    'domain',
    'problem_type',
    'deadline',
    'judging_deadline',
    'context',
    'problem_stmt',
    'scope',
    'constraints',
    'deliverables',
  ];
  const missing = [];
  for (const key of requiredText) {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push(key);
    }
  }
  const milestones = payload.milestones == null || payload.milestones === '' ? 3 : Number(payload.milestones);
  if (missing.length > 0) {
    return res.status(422).json({ error: `Missing or invalid fields: ${missing.join(', ')}` });
  }
  if (!Number.isInteger(milestones) || milestones < 2 || milestones > 5) {
    return res.status(422).json({ error: 'Milestones must be a whole number between 2 and 5.' });
  }
  if (payload.judging_deadline < payload.deadline) {
    return res.status(422).json({ error: 'Judging deadline must be on or after the submission deadline.' });
  }

  const shouldUpdateThumbnail = Object.prototype.hasOwnProperty.call(payload, 'thumbnail_url');
  const thumbnailUrl = payload.thumbnail_url == null
    ? null
    : normalizeProblemThumbnailUrl(payload.thumbnail_url);

  if (shouldUpdateThumbnail && payload.thumbnail_url != null && !thumbnailUrl) {
    return res.status(422).json({ error: 'Invalid thumbnail_url' });
  }

  const admin = getAdmin();
  const { data: problem } = await admin
    .from('problems')
    .select('poster_id')
    .eq('id', payload.id)
    .single();

  if (!problem || (req.profile.role === 'poster' && problem.poster_id !== user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const validTeamModes = ['solo', 'team', 'both'];
  const teamMode = payload.team_mode && validTeamModes.includes(payload.team_mode) ? payload.team_mode : undefined;

  const updateData = {
    title: payload.title,
    domain: payload.domain,
    problem_type: payload.problem_type,
    reward_amount: payload.reward_amount ?? null,
    milestones,
    deadline: payload.deadline,
    judging_deadline: payload.judging_deadline,
    context: payload.context,
    problem_stmt: payload.problem_stmt,
    scope: payload.scope,
    constraints: payload.constraints,
    deliverables: payload.deliverables,
  };

  if (teamMode) {
    updateData.team_mode = teamMode;
    if (payload.min_team_size != null) updateData.min_team_size = payload.min_team_size;
    if (payload.max_team_size != null) updateData.max_team_size = payload.max_team_size;
  }

  if (shouldUpdateThumbnail) {
    updateData.thumbnail_url = thumbnailUrl;
  }

  let warning = null;
  let { error } = await admin
    .from('problems')
    .update(updateData)
    .eq('id', payload.id);

  if (error && shouldUpdateThumbnail && isMissingProblemThumbnailColumnError(error.message)) {
    const fallbackUpdateData = { ...updateData };
    delete fallbackUpdateData.thumbnail_url;
    fallbackUpdateData.rejected_reason = encodeProblemThumbnailFallback(thumbnailUrl);
    const retry = await admin
      .from('problems')
      .update(fallbackUpdateData)
      .eq('id', payload.id);

    error = retry.error;

    if (!error && thumbnailUrl) {
      warning = 'Problem updated using temporary thumbnail storage because the database migration has not been applied yet.';
    }
  }

  if (error) {
    if (error.message && error.message.includes('problems_milestones_check')) {
      return res.status(422).json({ error: 'Milestones must be a whole number between 2 and 5.' });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, warning });
});

// ---- POST /api/problems/delete (port of app/api/problems/delete/route.ts) ----

router.post('/api/problems/delete', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const id = payload.id;
  if (!id) {
    return res.status(400).json({ error: 'Missing id' });
  }

  const admin = getAdmin();
  const { data: problem } = await admin
    .from('problems')
    .select('poster_id')
    .eq('id', id)
    .single();

  if (!problem || (req.profile.role === 'poster' && problem.poster_id !== user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { error } = await admin
    .from('problems')
    .delete()
    .eq('id', id);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
});

// ---- POST /api/problems/status (port of app/api/problems/status/route.ts) ----

router.post('/api/problems/status', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const id = payload.id;
  const status = payload.status;
  if (!id || !status || !['open', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status update' });
  }

  const admin = getAdmin();
  const { data: problem } = await admin
    .from('problems')
    .select('poster_id')
    .eq('id', id)
    .single();

  if (!problem || (req.profile.role === 'poster' && problem.poster_id !== user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { error } = await admin
    .from('problems')
    .update({ status })
    .eq('id', id);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
});

// ---- POST /api/problems/thumbnail (port of app/api/problems/thumbnail/route.ts) ----

router.post('/api/problems/thumbnail', authRequired, loadProfile, requireRole('poster', 'admin'), upload.single('file'), async (req, res) => {
  const user = req.user;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing image file.' });
  }

  const shim = { name: req.file.originalname, size: req.file.size, type: req.file.mimetype };
  const validationError = getProblemThumbnailError(shim);
  if (validationError) {
    return res.status(422).json({ error: validationError });
  }

  const admin = getAdmin();

  await admin.storage.createBucket(PROBLEM_THUMBNAIL_BUCKET, {
    public: true,
    fileSizeLimit: PROBLEM_THUMBNAIL_MAX_BYTES,
    allowedMimeTypes: PROBLEM_THUMBNAIL_ALLOWED_TYPES,
  }).catch(() => null);

  const filePath = `${user.id}/${Date.now()}-${crypto.randomUUID()}-${sanitizeProblemThumbnailFileName(req.file.originalname)}`;

  const { error: uploadError } = await admin.storage
    .from(PROBLEM_THUMBNAIL_BUCKET)
    .upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (uploadError) {
    return res.status(400).json({ error: uploadError.message });
  }

  const { data } = admin.storage
    .from(PROBLEM_THUMBNAIL_BUCKET)
    .getPublicUrl(filePath);

  return res.status(200).json({ url: data.publicUrl, path: filePath });
});

// ---- POST /api/problems/evaluate (port of app/api/problems/evaluate/route.ts) ----

router.post('/api/problems/evaluate', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (!body.problem_id) {
    return res.status(422).json({ error: 'problem_id is required' });
  }

  const admin = getAdmin();

  const { data: problem, error: fetchError } = await admin
    .from('problems')
    .select('*')
    .eq('id', body.problem_id)
    .single();

  if (fetchError || !problem) {
    return res.status(404).json({ error: 'Problem not found' });
  }

  const input = {
    title: problem.title ?? '',
    domain: problem.domain ?? '',
    problem_type: problem.problem_type ?? '',
    context: problem.context ?? '',
    problem_stmt: problem.problem_stmt ?? '',
    scope: problem.scope ?? '',
    constraints: problem.constraints ?? '',
    deliverables: problem.deliverables ?? '',
    milestones: problem.milestones ?? 3,
    deadline: problem.deadline ?? '',
    team_mode: problem.team_mode,
    min_team_size: problem.min_team_size,
    max_team_size: problem.max_team_size,
    mentor_required: problem.mentor_required,
  };

  const evaluation = await evaluateProblemWithAI(input);

  const { error: updateError } = await admin
    .from('problems')
    .update({
      difficulty_score: evaluation.difficulty_score,
      difficulty_label: evaluation.difficulty,
      leaderboard_weight: evaluation.leaderboard_weight,
      impact_score: evaluation.impact_score,
      estimated_hours: evaluation.estimated_hours,
      estimated_weeks: evaluation.estimated_weeks,
      evaluation_json: evaluation,
      evaluated_at: new Date().toISOString(),
    })
    .eq('id', body.problem_id);

  if (updateError) {
    console.error('Evaluation update failed:', updateError.message);
    return res.status(500).json({ error: 'Failed to save evaluation' });
  }

  return res.status(200).json({ ok: true, evaluation });
});

// ---- POST /api/problems/seed-test (port of app/api/problems/seed-test/route.ts) ----
// NOTE: preserves the exact 'Forbidden — admin only' message, so the role check
// is inline instead of requireRole('admin') (which returns plain 'Forbidden').

router.post('/api/problems/seed-test', authRequired, loadProfile, async (req, res) => {
  const user = req.user;

  if (!req.profile || req.profile.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — admin only' });
  }

  const admin = getAdmin();
  const results = [];

  for (const input of TEST_PROBLEMS) {
    try {
      const insertData = {
        title: input.title,
        domain: input.domain,
        problem_type: input.problem_type,
        status: 'open',
        reward_amount: input.problem_type === 'industry_challenge' ? 100000 : null,
        milestones: input.milestones,
        deadline: input.deadline,
        judging_deadline: new Date(new Date(input.deadline).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        context: input.context,
        problem_stmt: input.problem_stmt,
        scope: input.scope,
        constraints: input.constraints,
        deliverables: input.deliverables,
        poster_id: user.id,
        team_mode: input.team_mode ?? 'solo',
        min_team_size: input.min_team_size ?? 1,
        max_team_size: input.max_team_size ?? 4,
        mentor_required: input.mentor_required ?? false,
      };

      const { data: inserted, error: insertError } = await admin
        .from('problems')
        .insert(insertData)
        .select('id')
        .single();

      if (insertError || !inserted) {
        results.push({ title: input.title, success: false, error: insertError?.message ?? 'Insert failed' });
        continue;
      }

      const evaluation = await evaluateProblemWithAI(input);

      const { error: updateError } = await admin
        .from('problems')
        .update({
          difficulty_score: evaluation.difficulty_score,
          difficulty_label: evaluation.difficulty,
          leaderboard_weight: evaluation.leaderboard_weight,
          impact_score: evaluation.impact_score,
          estimated_hours: evaluation.estimated_hours,
          estimated_weeks: evaluation.estimated_weeks,
          evaluation_json: evaluation,
          evaluated_at: new Date().toISOString(),
        })
        .eq('id', inserted.id);

      if (updateError) {
        results.push({ title: input.title, success: false, error: updateError.message });
      } else {
        results.push({
          title: input.title,
          success: true,
          evaluation: {
            difficulty: evaluation.difficulty,
            difficulty_score: evaluation.difficulty_score,
            impact_score: evaluation.impact_score,
            estimated_hours: evaluation.estimated_hours,
          },
        });
      }
    } catch (err) {
      results.push({ title: input.title, success: false, error: String(err) });
    }
  }

  return res.status(200).json({ ok: true, results });
});

module.exports = router;
