// Scanner-specific types and frontmatter structures

export interface Frontmatter {
  name?: string;
  title?: string;
  subject?: string;
  type?: string;
  status?: string;
  date?: string;
  participants?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface ScannedKnowledge {
  type: string;
  title: string;
  filePath: string;
  tags?: string[];
  frontmatter?: Frontmatter;
  content?: string;
}

export interface ScanResult {
  knowledge: ScannedKnowledge[];
  /** Files the scan read but could not index as they are (unreadable, malformed frontmatter). */
  warnings?: Array<{ message: string; component?: string }>;
}
