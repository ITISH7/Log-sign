import { Notification } from 'electron';

export interface ReminderSettings {
  enabled: boolean;
  time: string;
}

export class ReminderScheduler {
  private timer?: NodeJS.Timeout;

  schedule(settings: ReminderSettings, onClick: () => void): void {
    this.cancel();
    if (!settings.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.time)) return;
    const [hours, minutes] = settings.time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours!, minutes!, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.timer = setTimeout(() => {
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: 'Add today’s work update',
          body: 'A minute now makes your DSR effortless later.'
        });
        notification.on('click', onClick);
        notification.show();
      }
      this.schedule(settings, onClick);
    }, next.getTime() - now.getTime());
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
