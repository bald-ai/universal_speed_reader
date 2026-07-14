import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativeEpubFolderFile = {
  name: string;
  size: number;
  uri: string;
  type?: string;
  relativePath?: string;
};

type NativeEpubFolderPickerResult = {
  canceled?: boolean;
  folderName?: string;
  files: NativeEpubFolderFile[];
};

type NativeEpubFolderPickerPlugin = {
  pickFiles(): Promise<NativeEpubFolderPickerResult>;
  pickFolder(): Promise<NativeEpubFolderPickerResult>;
};

export type NativeEpubFolderPickOutcome =
  | { status: "unavailable" }
  | { status: "canceled" }
  | { status: "selected"; folderName: string; files: NativeEpubFolderFile[] };

export type NativeBookFilePickOutcome =
  | { status: "unavailable" }
  | { status: "canceled" }
  | { status: "selected"; files: NativeEpubFolderFile[] };

const EpubFolderPicker = registerPlugin<NativeEpubFolderPickerPlugin>("EpubFolderPicker");

export function isNativeEpubFolderPickerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function pickNativeBookFiles(): Promise<NativeBookFilePickOutcome> {
  if (!isNativeEpubFolderPickerAvailable()) {
    return { status: "unavailable" };
  }

  const result = await EpubFolderPicker.pickFiles();
  if (result.canceled) {
    return { status: "canceled" };
  }

  return { status: "selected", files: result.files };
}

export async function pickNativeEpubFolder(): Promise<NativeEpubFolderPickOutcome> {
  if (!isNativeEpubFolderPickerAvailable()) {
    return { status: "unavailable" };
  }

  const result = await EpubFolderPicker.pickFolder();
  if (result.canceled) {
    return { status: "canceled" };
  }

  return {
    status: "selected",
    folderName: result.folderName?.trim() || "Selected folder",
    files: result.files,
  };
}

export async function readNativeEpubFolderFile(file: NativeEpubFolderFile): Promise<File> {
  const response = await fetch(Capacitor.convertFileSrc(file.uri));
  if (!response.ok) {
    throw new Error(`Could not read ${file.name}`);
  }

  const blob = await response.blob();
  return new File([blob], file.name, {
    type: file.type ?? "application/octet-stream",
    lastModified: Date.now(),
  });
}

export async function readNativeEpubFolderBytes(file: NativeEpubFolderFile): Promise<Uint8Array> {
  const response = await fetch(Capacitor.convertFileSrc(file.uri));
  if (!response.ok) {
    throw new Error(`Could not read ${file.name}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}
