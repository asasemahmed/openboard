import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

/** Renders whatever confirmation the board asked for (deleting a frame, tidying everything). */
export function ConfirmHost() {
  const { ui } = useSession();
  const request = useValue(ui.confirm);
  const close = () => ui.confirm.set(null);
  return (
    <Dialog
      open={request !== null}
      onClose={close}
      title={request?.title ?? ''}
      description={request?.body}
    >
      <div className="dialog-actions">
        {request?.actions.map((action, i) => (
          <Button
            key={action.label}
            variant={
              action.tone === 'danger'
                ? 'danger'
                : action.tone === 'primary'
                  ? 'primary'
                  : 'default'
            }
            data-autofocus={i === 0 ? true : undefined}
            // The least destructive choice gets focus, so Enter never deletes by accident.
            autoFocus={i === 0}
            onClick={() => {
              close();
              action.run();
            }}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
