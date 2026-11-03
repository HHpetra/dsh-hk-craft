'use strict'

/**
 * Fixed samples for the three formatting helpers, aligned to dsh 0.2.1-rc.5.
 *
 * The relative-path rows are the upstream `relativizeToCwd` table
 * (`@deepseek-ai/dsh-util-workspace-path` tests), plus spaces, Chinese and a
 * trailing separator. Mention rows lock the grammar the composer calls with
 * `kind: 'file'`.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { relativizeToCwd, workspaceTitleOf, formatFileMention } = require('./file-drop-format.js')

test('relativizeToCwd shortens a path only inside that workspace root', () => {
  const rows = [
    ['/work/report.txt', '/work', 'report.txt'],
    ['/work/reports/result.pdf', '/work/', 'reports/result.pdf'],
    ['/work-other/report.txt', '/work', '/work-other/report.txt'],
    ['/other/report.txt', '/work', '/other/report.txt'],
    ['report.txt', '/work', 'report.txt'],
    ['/work/report.txt', undefined, '/work/report.txt'],
    ['/work/report.txt', '', '/work/report.txt'],
    ['/report.txt', '/', 'report.txt'],
    [String.raw`C:\work\reports\result.pdf`, String.raw`C:\work`, String.raw`reports\result.pdf`],
    [String.raw`\\server\share\report.txt`, String.raw`\\server\share`, 'report.txt'],
    ['/work/my file.txt', '/work', 'my file.txt'],
    ['/work/我的 文件.txt', '/work/', '我的 文件.txt'],
    ['/work/报告.txt', '/work/', '报告.txt'],
    ['C:\\work\\我的 文件.txt', 'C:\\work\\', '我的 文件.txt'],
    ['/workspace/a.txt', '/work', '/workspace/a.txt'],
    ['/work', '/work', '/work'],
  ]
  for (const [path, cwd, expected] of rows) {
    assert.equal(relativizeToCwd(path, cwd), expected, `${path} @ ${cwd}`)
  }
})

test('workspaceTitleOf reads the final segment on both path styles', () => {
  const rows = [
    ['/work/project/', 'project'],
    ['C:\\work\\project\\', 'project'],
    ['/', ''],
    ['C:\\', 'C:'],
    ['notes.md', 'notes.md'],
    ['/work/我的 项目/', '我的 项目'],
    ['C:\\work\\我的 项目\\', '我的 项目'],
    ['/work/my file.txt', 'my file.txt'],
    ['\\\\server\\share\\report.txt', 'report.txt'],
    ['/work/project///', 'project'],
    ['', ''],
  ]
  for (const [path, expected] of rows) {
    assert.equal(workspaceTitleOf(path), expected, path)
  }
})

test('formatFileMention quotes whitespace and refuses a path the grammar cannot represent', () => {
  const rows = [
    [{ path: 'src/a.ts', kind: 'file' }, false, '@src/a.ts'],
    [{ path: 'notes.md', kind: 'file' }, true, '@"notes.md"'],
    [{ path: 'my file.txt', kind: 'file' }, false, '@"my file.txt"'],
    [{ path: '我的文件.txt', kind: 'file' }, false, '@我的文件.txt'],
    [{ path: '我的 文件.txt', kind: 'file' }, false, '@"我的 文件.txt"'],
    [{ path: 'dir', kind: 'directory' }, false, '@dir/'],
    [{ path: 'my dir', kind: 'directory' }, false, '@"my dir/'],
    [{ path: 'src/a.ts/', kind: 'file' }, false, '@src/a.ts/'],
    [{ path: 'my dir/', kind: 'file' }, false, '@"my dir/"'],
    [{ path: 'docs/我的 目录/', kind: 'file' }, false, '@"docs/我的 目录/"'],
    [{ path: 'bad"name', kind: 'file' }, false, undefined],
    [{ path: 'a\nb', kind: 'file' }, false, undefined],
    [{ path: 'a\u007fname', kind: 'file' }, false, undefined],
  ]
  for (const [candidate, preserveQuote, expected] of rows) {
    assert.equal(
      formatFileMention(candidate, preserveQuote),
      expected,
      `${candidate.kind}:${candidate.path}`,
    )
  }
})
