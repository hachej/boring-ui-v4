import type { ViewerFeature } from '@boring/ui';
import type { MarkdownController } from '@boring/ui/markdown';
import type { HtmlController } from '@boring/ui/html';
import { createCanvasController } from '@boring/ui/canvas';
import type { ExperienceDocumentController } from '@boring/ui/experience/document';
import type { TextDraftActions, TextDraftChoiceSelection, TextDraftRecoveryState } from '@boring/ui/text-buffer';
import type { SaveResult } from '@boring/ui/resources';

declare const markdown: ViewerFeature<{ kind: 'markdown'; version: 1 }, MarkdownController>;
declare const html: HtmlController;
declare const canvas: ReturnType<typeof createCanvasController>;
declare const experience: ExperienceDocumentController;
declare const choice: TextDraftChoiceSelection;

const editor = markdown.createController({ kind: 'markdown', version: 1 });
for (const controller of [editor, html, canvas, experience]) {
  const actions: TextDraftActions = controller.actions;
  const recovery: TextDraftRecoveryState = controller.getSnapshot().recovery;
  const save: Promise<SaveResult> = controller.flush(controller.actions.selection());
  void actions.restoreDraft(choice);
  void actions.discardDraft(choice);
  void actions.checkpointDraft();
  void recovery;
  void save;
}
void editor.actions.propose(editor.actions.selection(), [{ find: 'before', replace: 'after' }]);
void canvas.tools.inspect.invoke(canvas.actions.selection().target, { expiresAt: Date.now() + 1000 });
void experience.actions.pin(experience.actions.selection());
