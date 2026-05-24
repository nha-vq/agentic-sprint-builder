import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedProjectOverview } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import type { DevOutput, GeneratedFile, PreparedTechStackOutput } from '@/lib/types';

const DeployServiceSchema = z.object({
  name: z.string(),
  port: z.string(),
  healthUrl: z.string(),
  status: z.enum(['READY', 'BLOCKED'])
});

const DeployFindingSchema = z.object({
  category: z.string(),
  file: z.string(),
  finding: z.string(),
  fix: z.string().optional()
});

const DeployOutputSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_FIX']),
  blocking: z.array(DeployFindingSchema),
  advisory: z.array(DeployFindingSchema.omit({ fix: true })),
  deployCommand: z.string(),
  services: z.array(DeployServiceSchema),
  summary: z.string()
});

export type DeployOutput = z.infer<typeof DeployOutputSchema>;

const DeployJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'blocking', 'advisory', 'deployCommand', 'services', 'summary'],
  properties: {
    status: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'file', 'finding', 'fix'],
        properties: {
          category: { type: 'string' },
          file: { type: 'string' },
          finding: { type: 'string' },
          fix: { type: 'string' }
        }
      }
    },
    advisory: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'file', 'finding'],
        properties: {
          category: { type: 'string' },
          file: { type: 'string' },
          finding: { type: 'string' }
        }
      }
    },
    deployCommand: { type: 'string' },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'port', 'healthUrl', 'status'],
        properties: {
          name: { type: 'string' },
          port: { type: 'string' },
          healthUrl: { type: 'string' },
          status: { type: 'string', enum: ['READY', 'BLOCKED'] }
        }
      }
    },
    summary: { type: 'string' }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function extractDeploymentFiles(files: GeneratedFile[]) {
  const deployFiles = files.filter((file) =>
    /(dockerfile|docker-compose|compose\.ya?ml|\.env|\.dockerignore)/i.test(file.path)
  );
  return deployFiles
    .map((file) => `## ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join('\n\n');
}

function extractPackageManifests(files: GeneratedFile[]) {
  const manifests = files.filter((file) =>
    /(package\.json|requirements\.txt|pyproject\.toml|Gemfile|go\.mod|pom\.xml|build\.gradle)/i.test(file.path)
  );
  return manifests
    .map((file) => `## ${file.path}\n\`\`\`\n${truncate(file.content, 2_000)}\n\`\`\``)
    .join('\n\n');
}

export async function runDeployAgent(input: {
  requirements: string;
  devOutput: DevOutput;
  preparedTechStack?: PreparedTechStackOutput;
  existingFiles?: GeneratedFile[];
  modelOverride?: string;
  signal?: AbortSignal;
}): Promise<DeployOutput> {
  const files = input.existingFiles ?? input.devOutput.files;
  const projectOverview = formatGeneratedProjectOverview(files);
  const deploymentFiles = extractDeploymentFiles(files);
  const packageManifests = extractPackageManifests(files);

  const raw = await runMarkdownSkillAgent({
    agentId: 'deploy',
    modelOverride: input.modelOverride,
    fallbackTemperature: 0.1,
    maxTokens: 16_384,
    signal: input.signal,
    jsonSchema: {
      name: 'deploy_output',
      schema: DeployJsonSchema
    },
    userPrompt: `
Validate deployment configuration for the generated project.

PREPARED TECH STACK:
${input.preparedTechStack ? JSON.stringify(input.preparedTechStack, null, 2) : 'Not provided'}

GENERATED PROJECT OVERVIEW:
${projectOverview}

ARCHITECTURE:
${truncate(input.devOutput.architecture, 2_000)}

SETUP INSTRUCTIONS:
${truncate(input.devOutput.setupInstructions, 2_000)}

DEPLOYMENT FILES (Dockerfiles, Compose, .env):
${deploymentFiles || 'No deployment files found'}

PACKAGE MANIFESTS:
${packageManifests || 'No package manifests found'}

Validate: Docker Compose configuration, Dockerfile correctness, Dockerfile COPY sources against the generated file tree, port mappings, environment variables, healthchecks, startup commands, volume mounts, frontend build readiness signals, and overall deployment readiness.
Return JSON only.
`
  });

  return DeployOutputSchema.parse(extractJsonObject(raw));
}
