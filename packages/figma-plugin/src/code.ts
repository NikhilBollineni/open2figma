import type { O2FDocument } from '@open2figma/schema';
import { importDocument, type ImportOptions } from './builder.js';

figma.showUI(__html__, { width: 440, height: 600, themeColors: true });

type UIMessage =
  | { type: 'import'; document: O2FDocument; options: Partial<ImportOptions> }
  | { type: 'cancel' };

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.type === 'cancel') return figma.closePlugin();
  if (msg.type !== 'import') return;
  const started = Date.now();
  try {
    const { report } = await importDocument(msg.document, msg.options, (done, total, label) => {
      figma.ui.postMessage({ type: 'progress', done, total, label });
    });
    figma.ui.postMessage({ type: 'done', report, ms: Date.now() - started });
    figma.notify(`open2figma: imported ${report.nodes} nodes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: (err as Error).message, stack: (err as Error).stack });
    figma.notify(`open2figma failed: ${(err as Error).message}`, { error: true });
  }
};
