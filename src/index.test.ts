import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { execFileSync } from 'child_process';

const mockExecFileSync = mock(() => '');

describe('opencode-zellij-namer', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear();
  });

  describe('inferIntent', () => {
    test('detects test intent from commands', () => {
      const signals = ['bun test', 'jest --watch'];
      expect(inferIntentFromSignals(signals)).toBe('test');
    });

    test('detects debug intent from keywords', () => {
      const signals = ['debugging the auth flow', 'why is this broken'];
      expect(inferIntentFromSignals(signals)).toBe('debug');
    });

    test('detects fix intent from keywords', () => {
      const signals = ['fix the login bug', 'patch for issue #123'];
      expect(inferIntentFromSignals(signals)).toBe('fix');
    });

    test('detects refactor intent', () => {
      const signals = ['refactoring the database layer', 'cleanup old code'];
      expect(inferIntentFromSignals(signals)).toBe('refactor');
    });

    test('detects doc intent from file paths', () => {
      const signals = ['editing README.md', 'docs/api.md'];
      expect(inferIntentFromSignals(signals)).toBe('doc');
    });

    test('detects ops intent from devops keywords', () => {
      const signals = ['docker build', 'kubectl apply', 'terraform plan'];
      expect(inferIntentFromSignals(signals)).toBe('ops');
    });

    test('defaults to feat for general work', () => {
      const signals = ['implementing new feature', 'adding user profile'];
      expect(inferIntentFromSignals(signals)).toBe('feat');
    });
  });

  describe('buildSessionName', () => {
    test('builds simple name with project and intent', () => {
      expect(buildSessionName('myapp', 'feat')).toBe('myapp-feat');
    });

    test('builds name with tag', () => {
      expect(buildSessionName('myapp', 'feat', 'auth')).toBe('myapp-feat-auth');
    });

    test('sanitizes project name', () => {
      expect(buildSessionName('My App!', 'feat')).toBe('my-app-feat');
    });

    test('truncates long names to 48 chars', () => {
      const longProject = 'this-is-a-very-long-project-name-that-exceeds-limits';
      const result = buildSessionName(longProject, 'feat', 'authentication');
      expect(result.length).toBeLessThanOrEqual(48);
    });

    test('handles empty tag gracefully', () => {
      expect(buildSessionName('app', 'test', '')).toBe('app-test');
    });
  });

  describe('sanitize', () => {
    test('lowercases input', () => {
      expect(sanitize('MyApp')).toBe('myapp');
    });

    test('replaces invalid chars with dashes', () => {
      expect(sanitize('my_app@v2')).toBe('my-app-v2');
    });

    test('collapses multiple dashes', () => {
      expect(sanitize('my---app')).toBe('my-app');
    });

    test('removes leading and trailing dashes', () => {
      expect(sanitize('-myapp-')).toBe('myapp');
    });

    test('handles empty string', () => {
      expect(sanitize('')).toBe('');
    });
  });

  describe('extractProjectName', () => {
    test('extracts from package.json name', () => {
      const result = extractProjectName('/path/to/project', { name: 'my-project' });
      expect(result).toBe('my-project');
    });

    test('falls back to directory name', () => {
      const result = extractProjectName('/path/to/my-project', null);
      expect(result).toBe('my-project');
    });

    test('handles scoped packages', () => {
      const result = extractProjectName('/path', { name: '@org/my-package' });
      expect(result).toBe('my-package');
    });
  });

  describe('config', () => {
    test('uses default values when env vars not set', () => {
      const config = getConfig();
      expect(config.cooldownMs).toBe(300000);
      expect(config.debounceMs).toBe(5000);
      expect(config.maxSignals).toBe(25);
      expect(config.customInstructions).toBe('');
    });

    test('respects env var overrides', () => {
      process.env.OPENCODE_ZELLIJ_COOLDOWN_MS = '60000';
      const config = getConfig();
      expect(config.cooldownMs).toBe(60000);
      delete process.env.OPENCODE_ZELLIJ_COOLDOWN_MS;
    });

    test('loads custom instructions from env', () => {
      process.env.OPENCODE_ZN_INSTRUCTIONS = 'Always use short names, prefer abbreviations';
      const config = getConfig();
      expect(config.customInstructions).toBe('Always use short names, prefer abbreviations');
      delete process.env.OPENCODE_ZN_INSTRUCTIONS;
    });

    test('custom instructions default to empty string', () => {
      delete process.env.OPENCODE_ZN_INSTRUCTIONS;
      const config = getConfig();
      expect(config.customInstructions).toBe('');
    });
  });

  describe('custom instructions', () => {
    test('custom instructions are included in AI prompt when set', () => {
      const instructions = 'Use project codenames instead of directory names';
      const prompt = buildAIPrompt('myapp', ['working on auth'], null, instructions);
      expect(prompt).toContain('User instructions (take precedence over AGENTS.md):');
      expect(prompt).toContain(instructions);
    });

    test('custom instructions are omitted when empty', () => {
      const prompt = buildAIPrompt('myapp', ['working on auth'], null, '');
      expect(prompt).not.toContain('User instructions');
    });

    test('custom instructions are truncated at 500 chars', () => {
      const longInstructions = 'x'.repeat(600);
      const prompt = buildAIPrompt('myapp', ['working on auth'], null, longInstructions);
      const instructionsInPrompt = prompt.split('User instructions (take precedence over AGENTS.md):')[1];
      expect(instructionsInPrompt.length).toBeLessThanOrEqual(510);
    });
  });

  describe('AGENTS.md integration', () => {
    test('useAgentsMd is enabled by default', () => {
      delete process.env.OPENCODE_ZN_USE_AGENTS_MD;
      const config = getConfig();
      expect(config.useAgentsMd).toBe(true);
    });

    test('useAgentsMd can be disabled via env var', () => {
      process.env.OPENCODE_ZN_USE_AGENTS_MD = '0';
      const config = getConfig();
      expect(config.useAgentsMd).toBe(false);
      delete process.env.OPENCODE_ZN_USE_AGENTS_MD;
    });

    test('extracts naming section from AGENTS.md', () => {
      const content = `# Project
## Naming
Use short names. Prefer "api" over "backend".
Always include feature area.
## Other Section
Unrelated content.`;
      const guidance = extractNamingGuidance(content);
      expect(guidance).toContain('Use short names');
      expect(guidance).toContain('Prefer "api"');
      expect(guidance).not.toContain('Unrelated');
    });

    test('extracts Session Naming section', () => {
      const content = `# Project
## Session Naming Guidelines
Sessions should be named with ticket numbers.
## Other
Something else.`;
      const guidance = extractNamingGuidance(content);
      expect(guidance).toContain('ticket numbers');
    });

    test('falls back to Guidelines section with naming keywords', () => {
      const content = `# Project
## Guidelines
- Code should be clean
- Session naming should include team prefix
- Tests are important
## Other
Unrelated.`;
      const guidance = extractNamingGuidance(content);
      expect(guidance).toContain('Session naming should include team prefix');
      expect(guidance).not.toContain('Code should be clean');
    });

    test('returns null if no naming guidance found', () => {
      const content = `# Project
## Guidelines
- Code should be clean
- Tests are important
## Other
Unrelated.`;
      const guidance = extractNamingGuidance(content);
      expect(guidance).toBeNull();
    });

    test('truncates guidance to 400 chars', () => {
      const longGuidance = 'x'.repeat(500);
      const content = `## Naming\n${longGuidance}\n## Other`;
      const guidance = extractNamingGuidance(content);
      expect(guidance!.length).toBeLessThanOrEqual(400);
    });

    test('AGENTS.md guidance is included in AI prompt', () => {
      const agentsGuidance = 'Use team prefix "acme-" for all sessions';
      const prompt = buildAIPrompt('myapp', ['working on auth'], agentsGuidance, '');
      expect(prompt).toContain('Project naming guidelines from AGENTS.md:');
      expect(prompt).toContain(agentsGuidance);
    });

    test('custom instructions take precedence over AGENTS.md', () => {
      const agentsGuidance = 'Use team prefix "acme-"';
      const customInstructions = 'Ignore team prefix, use short names';
      const prompt = buildAIPrompt('myapp', ['working on auth'], agentsGuidance, customInstructions);
      
      const agentsIdx = prompt.indexOf('AGENTS.md');
      const customIdx = prompt.indexOf('User instructions (take precedence');
      expect(customIdx).toBeGreaterThan(agentsIdx);
      expect(prompt).toContain('take precedence over AGENTS.md');
    });

    test('both AGENTS.md and custom instructions can be present', () => {
      const agentsGuidance = 'Team naming conventions apply';
      const customInstructions = 'But prefer abbreviations';
      const prompt = buildAIPrompt('myapp', ['working on auth'], agentsGuidance, customInstructions);
      
      expect(prompt).toContain(agentsGuidance);
      expect(prompt).toContain(customInstructions);
    });
  });

  describe('ring buffer behavior', () => {
    test('caps signals at maxSignals', () => {
      const signals: string[] = [];
      const maxSignals = 5;
      
      for (let i = 0; i < 10; i++) {
        addSignal(signals, `signal-${i}`, maxSignals);
      }
      
      expect(signals.length).toBe(5);
      expect(signals[0]).toBe('signal-5');
      expect(signals[4]).toBe('signal-9');
    });

    test('truncates long signals', () => {
      const signals: string[] = [];
      const longSignal = 'x'.repeat(500);
      
      addSignal(signals, longSignal, 25);
      
      expect(signals[0].length).toBe(200);
    });
  });
});

function inferIntentFromSignals(signals: string[]): string {
  const text = signals.join(' ').toLowerCase();
  
  if (/\b(test|spec|jest|mocha|pytest|vitest)\b/.test(text)) return 'test';
  if (/\b(debug|breakpoint|trace|inspect|why)\b/.test(text)) return 'debug';
  if (/\b(fix|bug|patch|hotfix|issue|broken)\b/.test(text)) return 'fix';
  if (/\b(refactor|cleanup|reorganize|restructure)\b/.test(text)) return 'refactor';
  if (/\b(doc|readme|documentation|\.md)\b/.test(text)) return 'doc';
  if (/\b(review|pr|pull.request|merge)\b/.test(text)) return 'review';
  if (/\b(docker|k8s|kubernetes|terraform|ansible|deploy|ci|cd)\b/.test(text)) return 'ops';
  if (/\b(spike|explore|experiment|poc|prototype)\b/.test(text)) return 'spike';
  
  return 'feat';
}

function buildSessionName(project: string, intent: string, tag?: string): string {
  const sanitizedProject = sanitize(project).slice(0, 20);
  let name = `${sanitizedProject}-${intent}`;
  
  if (tag && tag.trim()) {
    const sanitizedTag = sanitize(tag).slice(0, 15);
    if (sanitizedTag) {
      name = `${name}-${sanitizedTag}`;
    }
  }
  
  return name.slice(0, 48);
}

function sanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

function extractProjectName(cwd: string, pkg: { name?: string } | null): string {
  if (pkg?.name) {
    const name = pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
    return sanitize(name);
  }
  return sanitize(cwd.split('/').pop() || 'project');
}

function getConfig() {
  return {
    cooldownMs: Number(process.env.OPENCODE_ZELLIJ_COOLDOWN_MS) || 300000,
    debounceMs: Number(process.env.OPENCODE_ZELLIJ_DEBOUNCE_MS) || 5000,
    maxSignals: Number(process.env.OPENCODE_ZELLIJ_MAX_SIGNALS) || 25,
    model: process.env.OPENCODE_ZELLIJ_MODEL || 'gemini-3-flash-preview',
    customInstructions: process.env.OPENCODE_ZN_INSTRUCTIONS || '',
    useAgentsMd: process.env.OPENCODE_ZN_USE_AGENTS_MD !== '0',
  };
}

function buildAIPrompt(
  project: string,
  signals: string[],
  agentsMdGuidance: string | null,
  customInstructions: string
): string {
  const safeSignals = signals.slice(-5).map((s) => s.slice(0, 100));
  
  let prompt = `Generate a short Zellij terminal session name.
Project: ${project}
Recent activity: ${safeSignals.join("; ")}

Rules:
- Format: project-intent or project-intent-tag
- Intent must be one of: feat, fix, debug, refactor, test, doc, ops, review, spike
- Tag is optional, 2-8 chars, describes specific area
- Total max 40 chars, lowercase, only a-z 0-9 and hyphens
- Return ONLY the session name, nothing else`;

  if (agentsMdGuidance) {
    prompt += `\n\nProject naming guidelines from AGENTS.md:\n${agentsMdGuidance}`;
  }

  if (customInstructions) {
    prompt += `\n\nUser instructions (take precedence over AGENTS.md):\n${customInstructions.slice(0, 500)}`;
  }

  return prompt;
}

function extractNamingGuidance(content: string): string | null {
  const namingSectionMatch = content.match(
    /##\s*(?:Session\s*)?Naming[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (namingSectionMatch) {
    return namingSectionMatch[1].trim().slice(0, 400);
  }

  const guidelinesMatch = content.match(
    /##\s*Guidelines[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (guidelinesMatch) {
    const guideContent = guidelinesMatch[1];
    const namingLines = guideContent
      .split("\n")
      .filter((line) => /naming|session|tag|intent/i.test(line))
      .join("\n");
    if (namingLines.length > 10) {
      return namingLines.trim().slice(0, 400);
    }
  }

  return null;
}

function addSignal(signals: string[], signal: string, maxSignals: number): void {
  signals.push(signal.slice(0, 200));
  if (signals.length > maxSignals) {
    signals.splice(0, signals.length - maxSignals);
  }
}
