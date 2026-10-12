/** Extracted text is unreviewed evidence, never an approved interpretation. */
export type SourceText = {
  status: "processing" | "available" | "unsupported" | "extraction_too_large" | "extraction_failed";
  text?: string;
  truncated?: boolean;
  reason?: string;
  pages?: number;
  coverage?: {
    pageStart: number;
    pageEnd: number;
    totalPages: number;
    truncated: boolean;
    nextPage: number | null;
  };
  retrieval?: {
    mode: "relevant_passages" | "pages";
    pageNumbers: number[];
    characters: number;
  };
};
