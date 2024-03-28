import { type ChatModel, Msg, createAIFunction } from '@dexaai/dexter'
import plur from 'plur'
import { z } from 'zod'

import type * as types from './types.js'
import type { LinterCache } from './cache.js'
import { mergeLinterConfigs } from './config.js'
import { parseInlineConfig } from './parse-inline-config.js'
import { omit, trimMessage } from './utils.js'

export async function lintFile({
  file,
  rule,
  chatModel,
  cache,
  config
}: {
  file: types.InputFile
  rule: types.Rule
  chatModel: ChatModel
  cache: LinterCache
  config: types.ResolvedLinterConfig
}): Promise<types.LintResult> {
  const lintResult: types.LintResult = {
    lintErrors: [],
    numModelCalls: 0,
    numModelCallsCached: 0,
    numPromptTokens: 0,
    numCompletionTokens: 0,
    numTotalTokens: 0,
    totalCost: 0
  }

  if (!file.content.trim()) {
    // Ignore empty files
    return lintResult
  }

  // TODO: add linter major version to cache key
  const cacheKey = {
    // Only keep the relative file path, content, and detected language
    file: omit(file, 'filePath', 'fileName'),

    // Remove rule fields which don't affect LLM logic
    rule: omit(rule, 'fixable', 'source', 'level'),

    // Ensure the cache key depends on how the LLM is parameterized
    params: chatModel.getParams()
  }

  const cachedResult = await cache.get(cacheKey)
  if (cachedResult) {
    lintResult.lintErrors = cachedResult.lintErrors
    lintResult.message = cachedResult.message
    lintResult.numModelCallsCached++

    if (config.linterOptions.debug) {
      const { lintErrors } = lintResult

      if (lintErrors.length) {
        console.log(
          `\nFAIL CACHE HIT Rule "${rule.name}" file "${
            file.fileRelativePath
          }": ${lintErrors.length} ${plur('error', lintErrors.length)} found:`,
          lintErrors
        )
      } else {
        console.log(
          `\nPASS CACHE HIT Rule "${rule.name}" file "${
            file.fileRelativePath
          }": ${lintErrors.length} ${plur(
            'error',
            lintErrors.length
          )} found: ${trimMessage(lintResult.message)}`
        )
      }
    }

    return lintResult
  }

  if (!config.linterOptions.noInlineConfig) {
    const configFileOverride = parseInlineConfig({ file })
    if (configFileOverride) {
      if (configFileOverride.linterOptions?.disabled) {
        // Inline config disabled linting for this file
        await cache.set(cacheKey, lintResult)
        return lintResult
      } else {
        // Inline config overrides for this file
        config = mergeLinterConfigs(
          config,
          configFileOverride
        ) as types.ResolvedLinterConfig
      }
    }
  }

  if (config.rules[rule.name] === 'off') {
    // Inline config disabled this rule for this file
    return lintResult
  }

  const recordRuleFailure = createAIFunction(
    {
      name: 'record_rule_failure',
      description:
        "Keeps track of snippets of code which fail to conform to the given rule's intent.",
      argsSchema: z.object({
        ruleName: z
          .string()
          .describe(
            'The name of the rule which this codeSnippet failed to conform to.'
          ),
        codeSnippet: z
          .string()
          .describe(
            'The offending code snippet which fails to conform to the given rule.'
          ),
        confidence: z
          .enum(['low', 'medium', 'high'])
          .describe('Your confidence that this error is correct.')
      })
    },
    async ({
      ruleName,
      codeSnippet,
      confidence
    }: {
      ruleName: string
      codeSnippet: string
      confidence: types.LintRuleErrorConfidence
    }) => {
      ruleName = ruleName.toLowerCase().trim()
      if (rule.name !== ruleName) {
        console.warn(
          `warning: rule "${rule.name}" LLM recorded error with unrecognized rule name "${ruleName}" on file "${file.fileRelativePath}"`
        )
      }

      lintResult.lintErrors.push({
        filePath: file.filePath,
        language: file.language,
        ruleName: rule.name,
        codeSnippet,
        confidence
      })
    }
  )

  if (config.linterOptions.debug) {
    console.log(`>>> Rule "${rule.name}" file "${file.fileRelativePath}"`)
  }

  const res = await chatModel.run({
    messages: [
      Msg.system(`You are an expert senior TypeScript software engineer at Vercel who loves to lint code. You make sure code conforms to project-specific guidelines and best practices. You will be given a code rule with a description of the rule's intent and one or more positive and negative code snippet examples.
    
Your task is to take the given code and determine whether any portions of it violate the rule's intent. Accuracy is important, so be sure to think step-by-step before invoking the "record_rule_failure" function and include a "confidence" value so it's clear how confident you when detecting possible errors.`),

      Msg.system(`# Rule name "${rule.name}"

${rule.message}

${rule.desc}

${rule.negativeExamples?.length ? '## Incorrect Examples\n' : ''}
${rule.negativeExamples?.map(
  (example) => `\`\`\`${example.language}\n${example.code}\n\`\`\`\n\n`
)}

${rule.positiveExamples?.length ? '## Correct Examples\n' : ''}
${rule.positiveExamples?.map(
  (example) => `\`\`\`${example.language}\n${example.code}\n\`\`\`\n\n`
)}
`),

      Msg.user(`File: ${file.fileName}:`),
      Msg.user(file.content)
    ],
    tools: [
      {
        type: 'function',
        function: recordRuleFailure.spec
      }
    ]
  })

  if (res.message.content) {
    lintResult.message = res.message.content
  }

  if (res.cached) {
    lintResult.numModelCallsCached++
  } else {
    lintResult.numModelCalls++
  }

  if (res.cost) {
    lintResult.totalCost += res.cost
  }

  if (res.usage) {
    lintResult.numPromptTokens += res.usage.prompt_tokens
    lintResult.numCompletionTokens += res.usage.completion_tokens
    lintResult.numTotalTokens += res.usage.total_tokens
  }

  if (config.linterOptions.debug) {
    const { lintErrors } = lintResult

    if (lintErrors.length) {
      console.log(
        `\n<<< FAIL CACHE MISS Rule "${rule.name}" file "${
          file.fileRelativePath
        }": ${lintErrors.length} ${plur('error', lintErrors.length)} found:`,
        lintErrors
      )
    } else {
      console.log(
        `\n<<< PASS CACHE MISS Rule "${rule.name}" file "${
          file.fileRelativePath
        }": ${lintErrors.length} ${plur(
          'error',
          lintErrors.length
        )} found: ${trimMessage(lintResult.message)}`
      )
    }
  }

  await cache.set(cacheKey, lintResult)
  return lintResult
}
