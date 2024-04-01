import type { ChatModel } from '@dexaai/dexter'
import pMap from 'p-map'

import type * as types from './types.js'
import type { LinterCache } from './cache.js'
import { lintFile } from './lint-file.js'
import { preLintFile } from './pre-lint-file.js'
import { createLintResult, mergeLintResults, pruneUndefined } from './utils.js'

export async function lintFiles({
  files,
  rules,
  config,
  cache,
  chatModel,
  onProgress,
  onProgressInit
}: {
  files: types.InputFile[]
  rules: types.Rule[]
  config: types.ResolvedLinterConfig
  cache: LinterCache
  chatModel: ChatModel
  onProgress?: types.ProgressHandlerFn
  onProgressInit?: types.ProgressHandlerInitFn
}): Promise<types.LintResult> {
  // TODO: Add support for different types of file <> rule mappings
  const lintTasks = rules.flatMap((rule) =>
    files.map((file) => ({ file, rule }))
  )
  let lintResult = createLintResult()
  let earlyExitTripped = false
  const warnings: Error[] = []

  // Preprocess the file / rule tasks so our progress bar has a clear indication of
  // how many non-cached, non-disabled tasks need to be processed
  const preLintResults = (
    await pMap(
      lintTasks,
      async ({ file, rule }) => {
        try {
          const preLintResult = await preLintFile({
            file,
            rule,
            chatModel,
            cache,
            config
          })

          if (preLintResult.lintResult) {
            lintResult = mergeLintResults(lintResult, preLintResult.lintResult)
          }

          return preLintResult
        } catch (err: any) {
          const error = new Error(
            `rule "${rule.name}" file "${file.fileRelativePath}" unexpected prelint error: ${err.message}`,
            { cause: err }
          )
          console.warn(error.message)
          warnings.push(error)
        }
      },
      {
        concurrency: config.linterOptions.concurrency
      }
    )
  ).filter(Boolean)

  const resolvedLintTasks = preLintResults.filter((r) => !r.lintResult)
  const skippedLintTasks = preLintResults.filter((r) => r.lintResult)
  const numTasksCached = skippedLintTasks.filter(
    (r) => r.skipReason === 'cached'
  ).length
  const numTasksPrecheck = skippedLintTasks.filter(
    (r) => r.skipReason === 'failed-precheck'
  ).length
  const numTasksDisabled = skippedLintTasks.filter(
    (r) =>
      r.skipReason === 'inline-linter-disabled' ||
      r.skipReason === 'rule-disabled'
  ).length

  console.log(
    'preLintResults',
    pruneUndefined({
      numTasks: resolvedLintTasks.length,
      numTasksCached: numTasksCached || undefined,
      numTasksPrecheck: numTasksPrecheck || undefined,
      numTasksDisabled: numTasksDisabled || undefined
    })
  )
  console.log(
    resolvedLintTasks.map((task) => ({
      file: task.file.fileRelativePath,
      rule: task.rule.name
    }))
  )

  if (config.linterOptions.earlyExit && lintResult.lintErrors.length) {
    earlyExitTripped = true
  }

  if (onProgressInit) {
    await Promise.resolve(
      onProgressInit({ numTasks: resolvedLintTasks.length })
    )
  }

  // Loop over each non-cached file / rule task and lint then with the LLM
  // linting engine and a capped max concurrency
  await pMap(
    resolvedLintTasks,
    async ({ file, rule, cacheKey, config }, index) => {
      if (earlyExitTripped) {
        return
      }

      try {
        const fileLintResult = await lintFile({
          file,
          rule,
          chatModel,
          config
        })

        if (cacheKey) {
          await cache.set(cacheKey, fileLintResult)
        }

        lintResult = mergeLintResults(lintResult, fileLintResult)

        if (config.linterOptions.earlyExit && lintResult.lintErrors.length) {
          earlyExitTripped = true
        }

        if (onProgress) {
          await Promise.resolve(
            onProgress({
              progress: index / resolvedLintTasks.length,
              message: `Rule "${rule.name}" file "${file.fileRelativePath}"`,
              result: lintResult
            })
          )
        }
      } catch (err: any) {
        const error = new Error(
          `rule "${rule.name}" file "${file.fileRelativePath}" unexpected error: ${err.message}`,
          { cause: err }
        )
        console.warn(error.message)
        warnings.push(error)
      }
    },
    {
      concurrency: config.linterOptions.concurrency
    }
  )

  return lintResult
}
