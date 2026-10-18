const $ = (id) => document.getElementById(id);
const start = $('start');
const snap = $('snap');
const send = $('send');
const reset = $('reset');
const video = $('video');
let stream = null;
let position = null;
let photo = null;
let generation = 0;
let sending = false;
let cameraTimer;

function stopCamera() {
  clearTimeout(cameraTimer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

function clearDraft(message = 'Подготовка отменена. Данные очищены, ничего не отправлено.') {
  generation++;
  stopCamera();
  position = null;
  photo = null;
  $('photo').removeAttribute('src');
  $('coordinates').textContent = '';
  $('capture').hidden = true;
  $('preview').hidden = true;
  reset.hidden = true;
  start.disabled = false;
  snap.disabled = true;
  send.disabled = true;
  $('status').textContent = message;
}

reset.addEventListener('click', () => { if (!sending) clearDraft('Данные в этой вкладке очищены. Уже отправленные сообщения остаются в Telegram.'); });

start.addEventListener('click', async () => {
  if (start.disabled) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !navigator.geolocation) {
    $('status').textContent = 'Камера или геолокация недоступны. Откройте демо в современном браузере по HTTPS или через localhost при локальном запуске.';
    return;
  }
  const run = ++generation;
  start.disabled = true;
  reset.hidden = false;
  $('status').textContent = 'Разрешите камеру в запросе браузера. Ничего не отправляется.';
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    // A permission prompt may resolve after cancellation or navigation.
    if (run !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired;
    video.srcObject = stream;
    $('capture').hidden = false;
    cameraTimer = setTimeout(() => clearDraft('Время предпросмотра истекло. Камера выключена, данные очищены.'), 120000);
    await video.play();
    if (run !== generation) return;
    $('status').textContent = 'Разрешите геолокацию в запросе браузера. Дождитесь координат перед снимком.';
    const result = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
    if (run !== generation) return;
    position = { latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy };
    snap.disabled = false;
    $('status').textContent = 'Геопозиция получена. Сделайте снимок по кнопке. Ничего не отправлено.';
  } catch (error) {
    if (run !== generation) return;
    const denied = error.name === 'NotAllowedError' || error.code === 1;
    clearDraft(denied ? 'Доступ отклонён. Камера выключена, данные очищены. Можно попробовать снова.' : 'Не удалось получить камеру или геопозицию. Проверьте устройство и разрешения браузера. Данные очищены.');
  }
});

snap.addEventListener('click', () => {
  if (!stream || !position || snap.disabled) return;
  if (!video.videoWidth || !video.videoHeight) { $('status').textContent = 'Камера ещё не готова. Попробуйте через секунду.'; return; }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  photo = canvas.toDataURL('image/jpeg', 0.85);
  stopCamera();
  $('capture').hidden = true;
  $('photo').src = photo;
  $('coordinates').textContent = `Широта: ${position.latitude}\nДолгота: ${position.longitude}\nТочность: ±${position.accuracy} м`;
  $('preview').hidden = false;
  send.disabled = false;
  $('status').textContent = 'Камера выключена. Проверьте фото и координаты. Для отправки нужна отдельная кнопка.';
  send.focus();
});

send.addEventListener('click', async () => {
  if (!photo || !position || sending || send.disabled) return;
  sending = true;
  send.disabled = true;
  reset.disabled = true;
  $('status').textContent = 'Отправляем подтверждённые фото и координаты в Telegram…';
  try {
    const response = await fetch('/api/check-in', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, photo, location: position }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error || 'Подтверждение не получено. Проверьте Telegram перед повтором.');
    clearDraft('Фото и координаты отправлены в Telegram владельца. Локальный предпросмотр очищен.');
  } catch (error) {
    $('status').textContent = error.name === 'TimeoutError' || error.name === 'TypeError'
      ? 'Связь прервалась. Сообщение могло дойти: проверьте Telegram перед повтором.' : error.message;
    send.disabled = false;
  } finally {
    sending = false;
    reset.disabled = false;
  }
});

window.addEventListener('pagehide', () => { generation++; stopCamera(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !sending && !reset.hidden) clearDraft('Вкладка скрыта: камера выключена, подготовленные данные очищены.');
});
