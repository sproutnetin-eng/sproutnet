'use strict';

const { evaluateProblem } = require('./problem-evaluator');

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const MODEL = 'llama-3.3-70b-versatile';

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
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
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
      difficulty_score: clamp(Number(parsed.difficulty_score) || 5, 0, 10),
      leaderboard_weight: validateWeight(parsed.difficulty_score ?? 5),
      impact_score: clamp(Number(parsed.impact_score) || 5, 0, 10),
      confidence: clamp(Number(parsed.confidence) || 0.5, 0, 1),
      estimated_hours: Math.round(Number(parsed.estimated_hours) || 40),
      estimated_weeks: Math.round(Number(parsed.estimated_weeks) || 2),
      recommended_team_size: {
        minimum: Math.max(1, Math.round(Number(parsed.recommended_team_size?.minimum) || 1)),
        maximum: Math.min(10, Math.round(Number(parsed.recommended_team_size?.maximum) || 4)),
      },
      weighted_breakdown: {
        technical_complexity: clamp(Number(parsed.weighted_breakdown?.technical_complexity) || 5, 0, 10),
        implementation_complexity: clamp(Number(parsed.weighted_breakdown?.implementation_complexity) || 5, 0, 10),
        engineering_effort: clamp(Number(parsed.weighted_breakdown?.engineering_effort) || 5, 0, 10),
        research_complexity: clamp(Number(parsed.weighted_breakdown?.research_complexity) || 5, 0, 10),
        testing_complexity: clamp(Number(parsed.weighted_breakdown?.testing_complexity) || 5, 0, 10),
        domain_knowledge: clamp(Number(parsed.weighted_breakdown?.domain_knowledge) || 5, 0, 10),
        collaboration_requirement: clamp(Number(parsed.weighted_breakdown?.collaboration_requirement) || 5, 0, 10),
        innovation_requirement: clamp(Number(parsed.weighted_breakdown?.innovation_requirement) || 5, 0, 10),
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  evaluateProblemWithAI,
};
