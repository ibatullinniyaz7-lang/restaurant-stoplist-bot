-- Записи, созданные старой ошибкой разбора кнопки окончания, восстановить нельзя:
-- выбранное окончание попало в start_time, а настоящее начало было потеряно.
DELETE FROM schedule_entries
WHERE is_day_off = 0
  AND (start_time = 'NaN:00' OR end_time = 'NaN:00');
