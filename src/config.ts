import findCacheDirectory from 'find-cache-dir'
import type { SetRequired, Simplify } from 'type-fest'
import { z } from 'zod'

import { dedupe } from './utils.js'

export const LinterConfigRuleSchema = z.enum(['off', 'warn', 'error'])
export type LinterConfigRule = z.infer<typeof LinterConfigRuleSchema>

// TODO: update when we decide project name
export const defaultCacheDir =
  findCacheDirectory({ name: 'eslint-plus-plus' }) ?? '.eslint-plus-plus'

export const LinterConfigOptionsSchema = z.object({
  noInlineConfig: z
    .boolean()
    .optional()
    .describe('A Boolean value for whether inline configuration is allowed.'),

  earlyExit: z
    .boolean()
    .optional()
    .describe(
      'A Boolean value for whether to exit greedily after finding the first error.'
    ),

  debug: z.boolean().optional().describe('Enables debug logging.'),

  noCache: z.boolean().optional().describe('Disables the built-in cache.'),

  cacheDir: z
    .string()
    .optional()
    .describe('A string path to the shared cache directory.'),

  model: z
    .string()
    .optional()
    .describe('Which LLM to use for assessing rule conformance.'),

  temperature: z
    .number()
    .min(0.0)
    .max(2.0)
    .optional()
    .describe('LLM temperature parameter.')
})
export type LinterConfigOptions = z.infer<typeof LinterConfigOptionsSchema>

export const LinterConfigSchema = z.object({
  files: z
    .array(z.string())
    .optional()
    .describe(
      'An array of glob patterns for the files to process. If not specified, the configuration object applies to all files matched by any other configuration object.'
    ),

  ignores: z
    .array(z.string())
    .optional()
    .describe('An array of glob patterns for files that should be ignored.'),

  guidelineFiles: z
    .array(z.string())
    .optional()
    .describe(
      'An array of glob patterns to guideline markdown files containing project-specific rule definitions.'
    ),

  ruleFiles: z
    .array(z.string())
    .optional()
    .describe('An array of glob patterns to rule definition markdown files.'),

  rules: z
    .record(z.string(), LinterConfigRuleSchema)
    .optional()
    .describe('An object customizing the configured rules.'),

  linterOptions: LinterConfigOptionsSchema.optional().describe(
    'An object containing settings related to the linting process.'
  )
})
export type LinterConfig = z.infer<typeof LinterConfigSchema>

export type ResolvedLinterConfig = Simplify<
  Omit<SetRequired<LinterConfig, keyof LinterConfig>, 'linterOptions'> & {
    linterOptions: SetRequired<LinterConfigOptions, keyof LinterConfigOptions>
  }
>

export const defaultLinterConfigOptions: LinterConfigOptions = {
  noInlineConfig: false,
  earlyExit: false,
  debug: false,
  noCache: false,
  cacheDir: defaultCacheDir,
  model: 'gpt-4-turbo-preview',
  temperature: 0
}

export const defaultLinterConfig: SetRequired<LinterConfig, 'linterOptions'> = {
  linterOptions: defaultLinterConfigOptions
}

export function parseLinterConfig(config: Partial<LinterConfig>): LinterConfig {
  return LinterConfigSchema.parse(config)
}

export function mergeLinterConfigs(
  configA: LinterConfig,
  configB: LinterConfig
): LinterConfig {
  return {
    ...configA,
    ...configB,
    files: dedupe([...(configA.files ?? []), ...(configB.files ?? [])]),
    ignores: dedupe([...(configA.ignores ?? []), ...(configB.ignores ?? [])]),
    guidelineFiles: dedupe([
      ...(configA.guidelineFiles ?? []),
      ...(configB.guidelineFiles ?? [])
    ]),
    ruleFiles: dedupe([
      ...(configA.ruleFiles ?? []),
      ...(configB.ruleFiles ?? [])
    ]),
    rules: { ...configA.rules, ...configB.rules },
    linterOptions:
      configA.linterOptions || configB.linterOptions
        ? { ...configA.linterOptions!, ...configB.linterOptions! }
        : undefined
  }
}