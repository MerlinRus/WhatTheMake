import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatOneDReader } from '@zxing/browser';

import {
  BarcodeScannerSession,
  type ScannerDecoder,
} from './scanner-session.js';

type CameraStatus =
  { kind: 'OPENING' } | { kind: 'ACTIVE' } | { kind: 'ERROR'; message: string };

export interface BarcodeScannerProps {
  onClose(): void;
  onDetected(value: string): void;
}

function isGtinCandidate(value: string): boolean {
  return /^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(value);
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Доступ к камере запрещён. Разрешите камеру в браузере или введите цифры вручную.';
    }
    if (error.name === 'NotFoundError') {
      return 'Камера не найдена. Введите цифры под штрихкодом вручную.';
    }
    if (error.name === 'NotReadableError') {
      return 'Камера занята другим приложением. Закройте его или используйте ручной ввод.';
    }
  }
  return 'Камеру не удалось запустить. Ручной ввод остаётся доступен.';
}

function createDecoder(): ScannerDecoder {
  const reader = new BrowserMultiFormatOneDReader();
  return {
    async decodeFromStream(stream, video, onDetected) {
      const controls = await reader.decodeFromStream(
        stream,
        video,
        (result) => {
          if (result === undefined || result === null) return;
          const value = result.getText().trim();
          if (isGtinCandidate(value)) onDetected(value);
        },
      );
      return { stop: () => controls.stop() };
    },
  };
}

export default function BarcodeScanner({
  onClose,
  onDetected,
}: BarcodeScannerProps) {
  const [status, setStatus] = useState<CameraStatus>({ kind: 'OPENING' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const mediaDevices = navigator.mediaDevices;
    if (video === null || mediaDevices?.getUserMedia === undefined) {
      setStatus({
        kind: 'ERROR',
        message:
          'Этот браузер не даёт доступ к камере. Введите штрихкод вручную.',
      });
      return;
    }

    const session = new BarcodeScannerSession(
      (constraints) => mediaDevices.getUserMedia(constraints),
      createDecoder(),
    );
    let detected = false;

    void session
      .start(video, (value) => {
        if (detected) return;
        detected = true;
        session.stop();
        onDetected(value);
      })
      .then((result) => {
        if (result === 'ACTIVE' && !detected) {
          setStatus({ kind: 'ACTIVE' });
        }
      })
      .catch((error: unknown) => {
        setStatus({ kind: 'ERROR', message: cameraErrorMessage(error) });
      });

    return () => session.stop();
  }, [onDetected]);

  return (
    <dialog
      ref={dialogRef}
      className="scanner-dialog"
      aria-labelledby="scanner-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">Локальное сканирование</span>
          <h2 id="scanner-title">Наведите на штрихкод</h2>
        </div>
        <button
          ref={closeButtonRef}
          className="scanner-close"
          type="button"
          onClick={onClose}
          aria-label="Закрыть камеру"
        >
          ×
        </button>
      </header>

      <div className="scanner-viewport">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Изображение с камеры"
        />
        {status.kind !== 'ERROR' && (
          <div className="scanner-guide" aria-hidden="true">
            <span />
          </div>
        )}
        {status.kind === 'OPENING' && (
          <div className="scanner-message" role="status">
            Запрашиваем доступ к камере…
          </div>
        )}
        {status.kind === 'ACTIVE' && (
          <div className="scanner-message" role="status">
            Держите код внутри рамки
          </div>
        )}
        {status.kind === 'ERROR' && (
          <div className="scanner-error" role="alert">
            <strong>Камера недоступна</strong>
            <p>{status.message}</p>
          </div>
        )}
      </div>

      <footer>
        <p>Кадры обрабатываются на устройстве и никуда не отправляются.</p>
        <button type="button" onClick={onClose}>
          Ввести цифры вручную
        </button>
      </footer>
    </dialog>
  );
}
