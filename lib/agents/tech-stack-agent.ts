import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatGeneratedProjectOverview, formatRunHistoryContext } from '@/lib/context/agent-context';
import { extractJsonObject } from '@/lib/utils/json';
import type { GeneratedFile, PreparedTechStackOutput, RunResult } from '@/lib/types';

const PreparedTechStackSchema = z.object({
  frontendFramework: z.string().min(1),
  backendFramework: z.string().min(1),
  database: z.string().min(1),
  ormMigrationTool: z.string().min(1),
  packageManager: z.string().min(1),
  runtimeVersions: z
    .array(
      z.object({
        name: z.string().min(1),
        version: z.string().min(1),
        notes: z.string().optional()
      })
    )
    .min(1),
  dockerStrategy: z.string().min(1),
  servicePorts: z
    .array(
      z.object({
        service: z.string().min(1),
        hostPort: z.coerce.number().int().positive(),
        containerPort: z.coerce.number().int().positive(),
        protocol: z.string().min(1)
      })
    )
    .min(1),
  environmentVariables: z.array(
    z.object({
      name: z.string().min(1),
      service: z.string().min(1),
      purpose: z.string().min(1),
      example: z.string(),
      required: z.coerce.boolean()
    })
  ),
  projectArchitecture: z.string().min(1),
  assumptions: z.array(z.string()),
  tradeoffs: z.array(z.string())
});

const PreparedTechStackJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'frontendFramework',
    'backendFramework',
    'database',
    'ormMigrationTool',
    'packageManager',
    'runtimeVersions',
    'dockerStrategy',
    'servicePorts',
    'environmentVariables',
    'projectArchitecture',
    'assumptions',
    'tradeoffs'
  ],
  properties: {
    frontendFramework: { type: 'string' },
    backendFramework: { type: 'string' },
    database: { type: 'string' },
    ormMigrationTool: { type: 'string' },
    packageManager: { type: 'string' },
    runtimeVersions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          notes: { type: 'string' }
        }
      }
    },
    dockerStrategy: { type: 'string' },
    servicePorts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['service', 'hostPort', 'containerPort', 'protocol'],
        properties: {
          service: { type: 'string' },
          hostPort: { type: 'number' },
          containerPort: { type: 'number' },
          protocol: { type: 'string' }
        }
      }
    },
    environmentVariables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'service', 'purpose', 'example', 'required'],
        properties: {
          name: { type: 'string' },
          service: { type: 'string' },
          purpose: { type: 'string' },
          example: { type: 'string' },
          required: { type: 'boolean' }
        }
      }
    },
    projectArchitecture: { type: 'string' },
    assumptions: {
      type: 'array',
      items: { type: 'string' }
    },
    tradeoffs: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

function formatPreparedTechStackForPrompt(output: PreparedTechStackOutput) {
  return JSON.stringify(output, null, 2);
}

export function formatPreparedTechStack(output?: PreparedTechStackOutput | null) {
  return output ? formatPreparedTechStackForPrompt(output) : 'Not prepared.';
}

export async function runPrepareTechStackAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
  signal?: AbortSignal;
}): Promise<PreparedTechStackOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingFiles = input.existingFiles ?? [];

  const raw = await runMarkdownSkillAgent({
    agentId: 'tech-stack',
    fallbackTemperature: 0.1,
    maxTokens: 8_192,
    jsonSchema: {
      name: 'prepared_tech_stack',
      schema: PreparedTechStackJsonSchema
    },
    signal: input.signal,
    userPrompt: `
Run prepare-tech-stack now using the loaded skill.
Do not skip this step. If information is incomplete, use the safe-default behavior defined in the loaded skill and record assumptions.

USER REQUIREMENTS:
${input.requirements}

USER TECH SPEC OR STACK HINTS:
${techSpec}

BA OUTPUT:
${input.baOutput}

EXISTING GENERATED CODE:
${formatGeneratedCodeContext(existingFiles)}

GENERATED PROJECT OVERVIEW:
${formatGeneratedProjectOverview(existingFiles)}

RECENT RUN HISTORY:
${formatRunHistoryContext(input.recentRuns ?? [])}
`
  });

  return PreparedTechStackSchema.parse(extractJsonObject(raw));
}
