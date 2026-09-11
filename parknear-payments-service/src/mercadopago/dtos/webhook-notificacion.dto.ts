export interface WebhookNotificationData {
  id?: string | number;
}

export interface WebhookNotificationDto {
  type?: string;
  data?: WebhookNotificationData;
}
