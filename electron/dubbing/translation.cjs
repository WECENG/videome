const path = require('node:path')

function translationPrompt(cues, index) {
  const context = cues.slice(Math.max(0, index - 1), index + 2).map((cue) => cue.text).join('\n')
  return `<|im_start|>system\n你是影视对白翻译。把指定英文翻译成简洁自然的简体中文，保留原意，适合配音。相邻句仅供上下文参考。只输出当前句译文，不要解释、编号或英文。/no_think<|im_end|>\n<|im_start|>user\n上下文：\n${context}\n当前句：${cues[index].text}\n/no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`
}

function translationArguments(modelsDirectory, promptPath) {
  // In the pinned llama.cpp b5401, --log-disable also suppresses generated
  // stdout. Keep stderr logging separate and stdout enabled for the answer.
  return ['-m', path.join(modelsDirectory, 'qwen3-4b.gguf'), '-f', promptPath,
    '-no-cnv', '--no-display-prompt', '--simple-io', '-n', '256', '-c', '2048',
    '-ngl', '99', '--temp', '0', '-r', '<|im_end|>']
}

function parseTranslation(output) {
  const translation = String(output || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/<\|[^>]+\|>/g, '')
    .replace(/\[end of text\]/g, '').trim()
  if (!translation || !/[\u3400-\u9fff]/.test(translation)) {
    throw new Error('翻译未返回有效中文，请点击“重试翻译”，或手工填写译文；已有识别和背景已保留。')
  }
  return translation
}

module.exports = { translationPrompt, translationArguments, parseTranslation }
