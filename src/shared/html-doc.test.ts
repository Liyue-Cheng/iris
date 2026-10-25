import { describe, expect, it } from 'vitest';
import {
  docFormatOf,
  extractHtmlReferences,
  getHtmlDocField,
  htmlDocSkeleton,
  htmlForAsset,
  isIrisDocFileName,
  readHtmlDocMetadata,
  setHtmlDocField,
  stripDocExtension,
} from './html-doc';
import { checkAllDocTaskCheckboxes, getDocField, setDocField } from './doc-fields';

const PAGE = [
  '<!doctype html>',
  '<html lang="zh">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <title>终端 &amp; 评审</title>',
  "  <meta content='Active' name=\"iris:status\">",
  '  <script>const fake = "<title>nope</title><meta name=\\"iris:status\\" content=\\"X\\">";</script>',
  '</head>',
  '<body>',
  '  <svg><title>icon</title></svg>',
  '  <img src="./doc.assets/a%20b.png">',
  '</body>',
  '</html>',
  '',
].join('\n');

describe('format detection', () => {
  it('classifies html/htm and md', () => {
    expect(docFormatOf('.iris/report/a.html')).toBe('html');
    expect(docFormatOf('.iris/report/a.HTM')).toBe('html');
    expect(docFormatOf('.iris/report/a.md')).toBe('markdown');
    expect(isIrisDocFileName('x.htm')).toBe(true);
    expect(isIrisDocFileName('x.txt')).toBe(false);
    expect(stripDocExtension('2026-10-25-a.html')).toBe('2026-10-25-a');
  });
});

describe('getHtmlDocField', () => {
  it('reads title and iris meta from the head, ignoring scripts and body', () => {
    expect(getHtmlDocField(PAGE, 'title')).toBe('终端 & 评审');
    expect(getHtmlDocField(PAGE, 'status')).toBe('Active');
    expect(getHtmlDocField(PAGE, 'labels')).toBeNull();
  });

  it('treats a fragment without head as metadata-free', () => {
    expect(getHtmlDocField('<svg><title>icon</title></svg>', 'title')).toBeNull();
    expect(readHtmlDocMetadata('<p>hi</p>')).toBeNull();
  });

  it('ignores commented-out metadata', () => {
    const html = '<head><!-- <title>old</title> --><title>new</title></head>';
    expect(getHtmlDocField(html, 'title')).toBe('new');
  });

  it('projects all iris:* metas as frontmatter-shaped data', () => {
    expect(readHtmlDocMetadata(PAGE)).toEqual({ title: '终端 & 评审', status: 'Active' });
  });
});

describe('setHtmlDocField', () => {
  it('replaces only the content token of an existing meta', () => {
    const out = setHtmlDocField(PAGE, 'status', 'Backlog');
    expect(out).toBe(PAGE.replace("content='Active'", 'content="Backlog"'));
  });

  it('replaces only the title text', () => {
    const out = setHtmlDocField(PAGE, 'title', 'A <b> & "c"');
    expect(out).toBe(PAGE.replace('终端 &amp; 评审', 'A &lt;b&gt; &amp; "c"'));
    expect(getHtmlDocField(out, 'title')).toBe('A <b> & "c"');
  });

  it('inserts a missing meta before </head> with matching indent', () => {
    const out = setHtmlDocField(PAGE, 'labels', 'x"y');
    expect(out).toContain('</script>\n  <meta name="iris:labels" content="x&quot;y">\n</head>');
    expect(getHtmlDocField(out, 'labels')).toBe('x"y');
    // Everything else is untouched.
    expect(out.replace('  <meta name="iris:labels" content="x&quot;y">\n', '')).toBe(PAGE);
  });

  it('preserves CRLF line endings', () => {
    const crlf = '<html>\r\n<head>\r\n  <title>a</title>\r\n</head>\r\n<body></body>\r\n</html>\r\n';
    const out = setHtmlDocField(crlf, 'status', 'Todo');
    expect(out).toBe(
      '<html>\r\n<head>\r\n  <title>a</title>\r\n  <meta name="iris:status" content="Todo">\r\n</head>\r\n<body></body>\r\n</html>\r\n',
    );
    expect(getHtmlDocField(out, 'status')).toBe('Todo');
  });

  it('creates a head when the page has none', () => {
    const withBody = '<html>\n<body>\n</body>\n</html>\n';
    const out = setHtmlDocField(withBody, 'title', 'T');
    expect(out).toBe('<html>\n<head>\n  <title>T</title>\n</head>\n<body>\n</body>\n</html>\n');

    const fragment = '<p>hi</p>\n';
    const fromFragment = setHtmlDocField(fragment, 'status', 'Active');
    expect(fromFragment).toBe('<head>\n  <meta name="iris:status" content="Active">\n</head>\n<p>hi</p>\n');
    expect(getHtmlDocField(fromFragment, 'status')).toBe('Active');
  });

  it('adds a content attribute to a meta that lacks one', () => {
    const html = '<head><meta name="iris:status"/></head>';
    expect(setHtmlDocField(html, 'status', 'Done')).toBe(
      '<head><meta name="iris:status" content="Done"/></head>',
    );
  });
});

describe('extractHtmlReferences', () => {
  it('collects src/href attributes outside inert regions', () => {
    const html = '<!-- <img src="ghost.png"> --><img src="./a.png"><a href="b.pdf">b</a><script src="c.js"></script>';
    expect(extractHtmlReferences(html)).toEqual([
      { source: './a.png', kind: 'image' },
      { source: 'b.pdf', kind: 'attachment' },
      { source: 'c.js', kind: 'attachment' },
    ]);
    expect(extractHtmlReferences(PAGE)).toEqual([{ source: './doc.assets/a%20b.png', kind: 'image' }]);
  });
});

describe('skeleton and snippets', () => {
  it('creates a standalone page whose metadata reads back', () => {
    const html = htmlDocSkeleton('季度 <评审>', 'Active');
    expect(getHtmlDocField(html, 'title')).toBe('季度 <评审>');
    expect(getHtmlDocField(html, 'status')).toBe('Active');
    expect(html.startsWith('<!doctype html>\n')).toBe(true);
  });

  it('renders asset snippets as HTML', () => {
    expect(htmlForAsset({ name: 'a.png', kind: 'image', markdownUrl: './x.assets/a.png' })).toBe(
      '<img src="./x.assets/a.png" alt="a">',
    );
    expect(htmlForAsset({ name: 'r.pdf', kind: 'attachment', markdownUrl: './x.assets/r.pdf' })).toBe(
      '<a href="./x.assets/r.pdf">r</a>',
    );
  });
});

describe('doc-fields dispatch', () => {
  it('routes markdown to frontmatter and html to head metadata', () => {
    const md = '---\ntitle: a\nstatus: Todo\n---\n- [ ] x\n';
    expect(getDocField('a.md', md, 'status')).toBe('Todo');
    expect(setDocField('a.md', md, 'status', 'Done')).toBe('---\ntitle: a\nstatus: Done\n---\n- [ ] x\n');
    expect(checkAllDocTaskCheckboxes('a.md', md)).toContain('- [x] x');

    expect(getDocField('a.html', PAGE, 'status')).toBe('Active');
    expect(setDocField('a.html', PAGE, 'status', 'Backlog')).toContain('content="Backlog"');
    expect(checkAllDocTaskCheckboxes('a.html', '- [ ] x')).toBe('- [ ] x');
  });
});
