import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff } from '../../src/main/diff-generator'

describe('diff-generator', () => {
  describe('parseUnifiedDiff', () => {
    it('returns empty array for empty input', () => {
      expect(parseUnifiedDiff('')).toEqual([])
    })

    it('parses a simple file modification', () => {
      const diff = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import express from 'express'
+import cors from 'cors'

 const app = express()
`
      const files = parseUnifiedDiff(diff)
      expect(files).toHaveLength(1)
      expect(files[0].path).toBe('src/index.ts')
      expect(files[0].status).toBe('modified')
      expect(files[0].linesAdded).toBe(1)
      expect(files[0].linesRemoved).toBe(0)
      expect(files[0].hunks).toHaveLength(1)
      expect(files[0].hunks[0].header).toBe('@@ -1,3 +1,4 @@')
      expect(files[0].hunks[0].lines).toHaveLength(4)
      expect(files[0].hunks[0].lines[1].type).toBe('addition')
      expect(files[0].hunks[0].lines[1].content).toBe("import cors from 'cors'")
    })

    it('parses additions and removals', () => {
      const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -5,3 +5,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].linesAdded).toBe(1)
      expect(files[0].linesRemoved).toBe(1)
      const lines = files[0].hunks[0].lines
      expect(lines[0].type).toBe('context')
      expect(lines[1].type).toBe('removal')
      expect(lines[1].content).toBe('const b = 2')
      expect(lines[2].type).toBe('addition')
      expect(lines[2].content).toBe('const b = 3')
      expect(lines[3].type).toBe('context')
    })

    it('assigns correct line numbers', () => {
      const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -10,4 +10,5 @@
 line10
 line11
+new line
 line12
 line13
`
      const files = parseUnifiedDiff(diff)
      const lines = files[0].hunks[0].lines
      expect(lines[0].oldLineNumber).toBe(10)
      expect(lines[0].newLineNumber).toBe(10)
      expect(lines[2].type).toBe('addition')
      expect(lines[2].oldLineNumber).toBeUndefined()
      expect(lines[2].newLineNumber).toBe(12)
      expect(lines[3].oldLineNumber).toBe(12)
      expect(lines[3].newLineNumber).toBe(13)
    })

    it('parses new file (added)', () => {
      const diff = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].status).toBe('added')
      expect(files[0].path).toBe('newfile.ts')
      expect(files[0].linesAdded).toBe(3)
    })

    it('parses deleted file', () => {
      const diff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].status).toBe('deleted')
      expect(files[0].path).toBe('old.ts')
      expect(files[0].linesRemoved).toBe(3)
    })

    it('parses renamed file', () => {
      const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].status).toBe('renamed')
      expect(files[0].path).toBe('new-name.ts')
      expect(files[0].oldPath).toBe('old-name.ts')
    })

    it('detects binary files', () => {
      const diff = `diff --git a/image.png b/image.png
index abc1234..def5678 100644
Binary files a/image.png and b/image.png differ
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].isBinary).toBe(true)
      expect(files[0].hunks).toHaveLength(0)
    })

    it('parses multiple files in one diff', () => {
      const diff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 a
+b
 c
 d
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,2 @@
-old
+new
 end
`
      const files = parseUnifiedDiff(diff)
      expect(files).toHaveLength(2)
      expect(files[0].path).toBe('file1.ts')
      expect(files[1].path).toBe('file2.ts')
    })

    it('parses multiple hunks in one file', () => {
      const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added1
 line2
 line3
@@ -10,3 +11,4 @@
 line10
+added2
 line11
 line12
`
      const files = parseUnifiedDiff(diff)
      expect(files[0].hunks).toHaveLength(2)
      expect(files[0].hunks[0].header).toBe('@@ -1,3 +1,4 @@')
      expect(files[0].hunks[1].header).toBe('@@ -10,3 +11,4 @@')
    })

    it('handles empty diff lines (no trailing space)', () => {
      const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1

-line3
+line3modified
`
      const files = parseUnifiedDiff(diff)
      // Empty line should be treated as context
      expect(files[0].hunks[0].lines[1].type).toBe('context')
      expect(files[0].hunks[0].lines[1].content).toBe('')
    })
  })
})
