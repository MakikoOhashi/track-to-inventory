export type PdfToImageResult = {
  url: string;
};

export type UploadShipmentFileInput = {
  siNumber: string;
  type: string;
  file: File;
};

export type UploadShipmentFileResult = {
  filePath: string;
  signedUrl: string;
  message: string;
};

export type GetFileUrlsInput = {
  filePaths: string | string[];
  siNumber?: string;
  shopId?: string;
};

export type GetFileUrlsResult = {
  signedUrls: Record<string, string>;
  signedUrl?: string;
  errors?: string[];
};
