// Brücke zwischen Oberfläche und Hauptprozess: stellt window.api bereit.

import { contextBridge, ipcRenderer } from 'electron'
import type { Api, Progress } from '../shared/types'

const METHODS: (keyof Omit<Api, 'onProgress'>)[] = [
  'info', 'getConfig', 'saveConfig', 'setApiKey', 'clearApiKey',
  'subjects', 'addSubject', 'renameSubject', 'deleteSubject', 'mergeSubjects', 'questionCounts',
  'sources', 'pickSources', 'setSourceMode', 'removeSources', 'moveSources', 'scan', 'generatedHashes', 'generate', 'cancelGenerate',
  'questions', 'saveQuestion', 'deleteQuestions', 'moveQuestions', 'generateTitles', 'setApproved', 'openSource',
  'practiceSets', 'setSubjects', 'addPracticeSet', 'renamePracticeSet', 'setPracticeMinutes', 'deletePracticeSet',
  'setQuestionIds', 'addToSet', 'reorderSet',
  'successRates', 'subjectStats', 'recordAttempt', 'updateAttempt', 'grade',
  'exportData', 'importData',
]

const api: Record<string, unknown> = {}
for (const name of METHODS) {
  api[name] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke(`api:${name}`, ...args)) as { ok: boolean; value?: unknown; error?: string }
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
}
api.onProgress = (cb: (p: Progress) => void) => {
  const listener = (_e: unknown, p: Progress) => cb(p)
  ipcRenderer.on('progress', listener)
  return () => ipcRenderer.removeListener('progress', listener)
}

contextBridge.exposeInMainWorld('api', api)
