# Local reference extraction

Runs Poppler text extraction and Tesseract German/English OCR locally. Reads originals without changing them and writes derivative evidence to `context/reference-extracted`.

Requirements: Python 3.10+, Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`), Tesseract 5, and local `models/deu.traineddata` plus `models/eng.traineddata`. Language data comes from the [official Tesseract tessdata_fast repository](https://github.com/tesseract-ocr/tessdata_fast); model SHA-256 values and tool versions are recorded in each manifest. Models are ignored by Git.

```sh
python3 tools/reference-extraction/extract.py
```

Optional `--input` and `--output` directories must keep output outside the source folder. No network requests or AI calls occur in the script. The output contains source identities, page-level JSONL, readable Markdown, native layout coordinates, OCR word boxes and scan previews. Exact duplicates share extraction; concatenated bundles are marked by normalized page-text comparison, not assumed visually identical.

Extraction remains unreviewed. It does not interpret engineering formulas, certify facts or infer approval. Files without an available parser remain listed as unsupported; scans/images without detected text remain explicit. OCR uses sparse-text segmentation and a bounded rendering resolution, so small or rotated annotations may need a closer visual pass.
