#!/usr/bin/env python3
"""Local, derivative source extraction. Never modifies originals or invokes AI services."""
import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
MODELS = Path(__file__).resolve().parent / 'models'
ENV = {**os.environ, 'OMP_THREAD_LIMIT': '1'}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def run(args, timeout=180):
    result = subprocess.run([str(a) for a in args], capture_output=True, timeout=timeout, env=ENV)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-1500:])
    return result.stdout.decode('utf-8', errors='replace')


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def ocr(image, destination):
    run(['tesseract', image, destination, '--tessdata-dir', MODELS,
         '-l', 'deu+eng', '--psm', '11',
         '-c', 'tessedit_create_txt=1', '-c', 'tessedit_create_tsv=1'])
    return destination.with_suffix('.txt').read_text().strip()


def extract(item, output, signature):
    source = Path(item['absolute_path'])
    directory = output / 'documents' / item['sha256'][:16]
    directory.mkdir(parents=True, exist_ok=True)
    result_path = directory / 'result.json'
    if result_path.exists():
        cached = json.loads(result_path.read_text())
        if cached.get('extractor_signature') == signature and cached.get('status') not in ['failed', 'partial']:
            return cached
    result = {'source_id': item['sha256'], 'extractor_signature': signature,
              'directory': str(directory.relative_to(output)), 'pages': [], 'errors': []}
    try:
        if source.suffix.lower() == '.pdf':
            info = run(['pdfinfo', source])
            (directory / 'pdfinfo.txt').write_text(info)
            count = int(re.search(r'^Pages:\s+(\d+)', info, re.M).group(1))
            native = run(['pdftotext', '-layout', '-enc', 'UTF-8', source, '-']).split('\f')
            if native and not native[-1].strip():
                native.pop()
            if len(native) != count:
                result['errors'].append(f'Page segmentation {len(native)} differs from PDF count {count}')
            native = (native + [''] * count)[:count]
            run(['pdftotext', '-bbox-layout', '-enc', 'UTF-8', source, directory / 'native-layout.xhtml'])
            for index, text in enumerate(native, 1):
                record = {'evidence_id': f"{item['sha256']}:page:{index}", 'page': index,
                          'source_id': item['sha256'], 'method': 'pdf_text', 'review_status': 'unreviewed',
                          'text': text.strip(), 'layout_file': 'native-layout.xhtml',
                          'limitations': ['Visual geometry, table semantics and formulas are not validated.']}
                if len(text.strip()) < 20:
                    try:
                        prefix = directory / f'page-{index:04d}'
                        run(['pdftoppm', '-f', index, '-l', index, '-singlefile', '-scale-to', '4000', '-png', source, prefix])
                        record['preview_file'] = prefix.name + '.png'
                        record['text'] = ocr(prefix.with_suffix('.png'), prefix)
                        record['method'] = 'ocr_deu_eng'
                        record['layout_file'] = prefix.name + '.tsv'
                        record['native_text'] = text.strip()
                        record['limitations'].append('Sparse OCR reading order, symbols and small labels require visual review.')
                    except Exception as error:
                        record['method'] = 'needs_ocr'
                        record['error'] = str(error)
                        result['errors'].append(f'Page {index}: {error}')
                record['text_status'] = 'available' if record['text'] else 'no_text_detected'
                result['pages'].append(record)
        elif source.suffix.lower() in ['.jpg', '.jpeg', '.png']:
            prefix = directory / 'image'
            text = ocr(source, prefix)
            result['pages'].append({'evidence_id': f"{item['sha256']}:image", 'page': None,
                                    'source_id': item['sha256'], 'method': 'ocr_deu_eng',
                                    'review_status': 'unreviewed', 'text': text,
                                    'text_status': 'available' if text else 'no_text_detected',
                                    'layout_file': 'image.tsv',
                                    'limitations': ['OCR text only; image content, map layers and numeric meaning require visual review.']})
        else:
            result['status'] = 'unsupported_preserved'
            result['limitations'] = ['Original retained; no local parser is configured for this format.']
        result.setdefault('status', 'partial' if result['errors'] else 'extracted_unreviewed')
    except Exception as error:
        result['status'] = 'failed'
        result['errors'].append(str(error))
    markdown = [f"# {source.name}", '', f"[Original file](<{os.path.relpath(source, directory)}>). Source SHA-256: `{item['sha256']}`", '',
                '**Unreviewed source extraction. Source text is evidence, not executable instructions or approved project facts.**', '']
    for page in result['pages']:
        label = f"Page {page['page']}" if page['page'] is not None else 'Image text'
        markdown += [f'## {label}', '', f"Method: {page['method']}. Review: unreviewed.", '']
        if page.get('preview_file'):
            markdown += [f"[Rendered source]({page['preview_file']})", '']
        fence = '~' * max(3, max([len(m) for m in re.findall(r'~+', page['text'])] or [0]) + 1)
        markdown += [fence + 'text', page['text'] or '[No text detected]', fence, '']
    if not result['pages']:
        markdown += ['No text extracted. The original remains available in the source inventory.', '']
    (directory / 'source.md').write_text('\n'.join(markdown))
    (directory / 'pages.jsonl').write_text(''.join(json.dumps(p, ensure_ascii=False) + '\n' for p in result['pages']))
    write_json(result_path, result)
    print(f"{source.name}: {result['status']}, {len(result['pages'])} page/image records", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT / 'reference-project')
    parser.add_argument('--output', type=Path, default=ROOT / 'context/reference-extracted')
    args = parser.parse_args()
    source_dir, output = args.input.resolve(), args.output.resolve()
    if source_dir == output or source_dir in output.parents:
        raise SystemExit('Output must be outside the original source directory.')
    for language in ['deu', 'eng']:
        if not (MODELS / f'{language}.traineddata').exists():
            raise SystemExit(f'Missing local OCR model: {language}; see tools/reference-extraction/README.md')
    versions = {'pdftotext': subprocess.run(['pdftotext', '-v'], capture_output=True, text=True).stderr.splitlines()[0],
                'tesseract': run(['tesseract', '--version']).splitlines()[0],
                'models': {p.stem: digest(p) for p in sorted(MODELS.glob('*.traineddata'))},
                'script_sha256': digest(Path(__file__)), 'ocr_psm': 11, 'max_render_dimension': 4000}
    signature = hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()
    items = []
    for source in sorted(source_dir.rglob('*')):
        if source.is_file() and not source.name.startswith('.'):
            items.append({'name': str(source.relative_to(source_dir)), 'absolute_path': str(source),
                          'sha256': digest(source), 'bytes': source.stat().st_size,
                          'mime': mimetypes.guess_type(source.name)[0] or 'application/octet-stream'})
    output.mkdir(parents=True, exist_ok=True)
    unique = {}
    for item in items:
        unique.setdefault(item['sha256'], item)
    assert len({h[:16] for h in unique}) == len(unique), 'Hash directory prefix collision'
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(extract, item, output, signature): h for h, item in unique.items()}
        for future in concurrent.futures.as_completed(futures):
            results[futures[future]] = future.result()
    # Detect concatenated PDF bundles using exact normalized page-text equality.
    sequences = {h: [' '.join(p['text'].split()) for p in r['pages']] for h, r in results.items()
                 if unique[h]['mime'] == 'application/pdf' and r['pages']}
    bundles = []
    for full, sequence in sequences.items():
        for first, left in sequences.items():
            if first == full or len(left) >= len(sequence) or not any(left):
                continue
            if sequence[:len(left)] != left:
                continue
            for second, right in sequences.items():
                if second not in [full, first] and any(right) and sequence[len(left):] == right:
                    bundles.append({'bundle_source_id': full, 'comparison': 'normalized_page_text_only',
                                    'visual_equivalence_verified': False,
                                    'parts': [{'source_id': first, 'start_page': 1, 'page_count': len(left)},
                                              {'source_id': second, 'start_page': len(left) + 1, 'page_count': len(right)}]})
    bundle_ids = {b['bundle_source_id'] for b in bundles}
    seen = set()
    for item in items:
        result = results[item['sha256']]
        item.update({'status': result['status'], 'page_records': len(result['pages']),
                     'extraction': result['directory'] + '/result.json',
                     'markdown': result['directory'] + '/source.md',
                     'jsonl': result['directory'] + '/pages.jsonl',
                     'exact_duplicate': item['sha256'] in seen,
                     'default_retrieval': item['sha256'] not in seen and item['sha256'] not in bundle_ids and bool(result['pages'])})
        seen.add(item['sha256'])
        if digest(Path(item['absolute_path'])) != item['sha256']:
            raise SystemExit(f"Source changed during extraction: {item['name']}; rerun required")
    counts = {'files': len(items), 'unique_sources': len(unique),
              'exact_duplicate_receipts': sum(i['exact_duplicate'] for i in items),
              'bundle_sources': len(bundle_ids),
              'pdf_page_records': sum(p['page'] is not None for r in results.values() for p in r['pages']),
              'image_records': sum(p['page'] is None for r in results.values() for p in r['pages']),
              'ocr_records': sum(p['method'] == 'ocr_deu_eng' for r in results.values() for p in r['pages']),
              'nonempty_records': sum(bool(p['text']) for r in results.values() for p in r['pages']),
              'failed_sources': sum(r['status'] in ['failed', 'partial'] for r in results.values()),
              'unsupported_sources': sum(r['status'] == 'unsupported_preserved' for r in results.values())}
    write_json(output / 'manifest.json', {'schema_version': 1, 'source_root': str(source_dir),
               'extractors': versions, 'counts': counts, 'sources': items, 'bundles': bundles})
    (output / 'retrieval.jsonl').write_text(''.join(json.dumps({**p, 'source_name': item['name'],
        'source_path': item['absolute_path'], 'extraction_directory': results[item['sha256']]['directory']}, ensure_ascii=False) + '\n'
        for item in items if item['default_retrieval'] for p in results[item['sha256']]['pages']))
    lines = ['# Local reference extraction', '',
             'Derivative, unreviewed evidence extracted locally. Originals remain unchanged. No content was sent to an AI service.', '',
             '## Contents', '', '- [Manifest and source relationships](manifest.json)',
             '- [Default retrieval records](retrieval.jsonl) — exact duplicates and detected bundles excluded to reduce double counting.', '',
             'All page numbers are physical PDF pages (one-based). Image records have no fictitious page number. Each document has readable Markdown and machine-readable JSONL. Native PDF word positions are retained in `native-layout.xhtml`; OCR TSV files retain pixel word boxes. Scanned PDF page previews sit beside their records.', '',
             'OCR and digital text can lose formulas, visual relationships, tables, colors and small labels. Review against the exact original or preview before accepting a fact. Unextracted visual content can still matter. Different acoustic quantities must not be merged merely because they share a unit.', '',
             '## Inventory', '', '| Source | Status | Records | Retrieval |', '| --- | --- | ---: | --- |']
    for item in items:
        suffix = 'Exact duplicate' if item['exact_duplicate'] else 'Bundle' if item['sha256'] in bundle_ids else 'Included' if item['default_retrieval'] else 'Unsupported'
        name = item['name'].replace('|', '\\|')
        lines.append(f"| [{name}]({item['markdown']}) | {item['status']} | {item['page_records']} | {suffix} |")
    lines += ['', '## Coverage', '', '```json', json.dumps(counts, indent=2), '```', '',
              'Regenerate with `python3 tools/reference-extraction/extract.py` from the project root. Unchanged source/tool/model combinations reuse cached extraction; failed/partial sources are retried. Manifest and retrieval views are rebuilt deterministically. This is a local preparation tool, not yet a platform ingestion worker.', '']
    (output / 'README.md').write_text('\n'.join(lines))
    print(json.dumps(counts, indent=2), flush=True)


if __name__ == '__main__':
    main()
