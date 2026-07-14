package com.traycer.speedreader;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashSet;
import java.util.Set;

@CapacitorPlugin(name = "EpubFolderPicker")
public class EpubFolderPickerPlugin extends Plugin {
    private static final int MAX_BOOK_FILES = 1000;
    private static final String EPUB_MIME_TYPE = "application/epub+zip";
    private static final String PDF_MIME_TYPE = "application/pdf";
    private static final Uri DOWNLOADS_ROOT_URI = Uri.parse(
        "content://com.android.providers.downloads.documents/root/downloads"
    );
    private static final Uri DOWNLOADS_DOCUMENT_URI = Uri.parse(
        "content://com.android.providers.downloads.documents/document/downloads"
    );

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { EPUB_MIME_TYPE, PDF_MIME_TYPE });
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DOWNLOADS_ROOT_URI);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        startActivityForResult(call, intent, "handleFilePickerResult");
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DOWNLOADS_DOCUMENT_URI);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);

        startActivityForResult(call, intent, "handleFolderPickerResult");
    }

    @ActivityCallback
    private void handleFilePickerResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            resolveCanceled(call);
            return;
        }

        Set<Uri> selectedUris = new LinkedHashSet<>();
        if (data.getData() != null) {
            selectedUris.add(data.getData());
        }
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index += 1) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) {
                    selectedUris.add(uri);
                }
            }
        }

        ContentResolver resolver = getContext().getContentResolver();
        JSArray files = new JSArray();
        for (Uri uri : selectedUris) {
            if (files.length() >= MAX_BOOK_FILES) {
                break;
            }
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // The current picker grant is still enough for this app session.
            }
            appendSelectedFile(resolver, uri, files);
        }

        JSObject response = new JSObject();
        response.put("canceled", false);
        response.put("files", files);
        call.resolve(response);
    }

    @ActivityCallback
    private void handleFolderPickerResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            resolveCanceled(call);
            return;
        }

        Uri treeUri = data.getData();
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // The current picker grant is still enough for this app session.
        }

        try {
            String rootDocumentId = DocumentsContract.getTreeDocumentId(treeUri);
            JSArray files = new JSArray();
            collectBookFiles(resolver, treeUri, rootDocumentId, "", files);

            JSObject response = new JSObject();
            response.put("canceled", false);
            response.put("folderName", getDocumentName(resolver, treeUri, rootDocumentId));
            response.put("files", files);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Could not read books from the selected folder", error);
        }
    }

    private void collectBookFiles(
        ContentResolver resolver,
        Uri treeUri,
        String documentId,
        String parentPath,
        JSArray files
    ) {
        if (files.length() >= MAX_BOOK_FILES) {
            return;
        }

        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
        String[] projection = new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        };

        try (Cursor cursor = resolver.query(childrenUri, projection, null, null, null)) {
            if (cursor == null) {
                return;
            }

            int idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            int mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);

            while (cursor.moveToNext() && files.length() < MAX_BOOK_FILES) {
                String childDocumentId = getString(cursor, idIndex);
                String displayName = getString(cursor, nameIndex);
                String mimeType = getString(cursor, mimeIndex);
                if (childDocumentId == null || displayName == null) {
                    continue;
                }

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
                    collectBookFiles(resolver, treeUri, childDocumentId, appendPath(parentPath, displayName), files);
                    continue;
                }

                if (!isSupportedBook(displayName, mimeType)) {
                    continue;
                }

                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocumentId);
                JSObject file = new JSObject();
                file.put("name", displayName);
                file.put("size", getLong(cursor, sizeIndex));
                file.put("uri", documentUri.toString());
                file.put("type", mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
                file.put("relativePath", appendPath(parentPath, displayName));
                files.put(file);
            }
        }
    }

    private boolean isSupportedBook(String displayName, String mimeType) {
        String lowerName = displayName.toLowerCase();
        return EPUB_MIME_TYPE.equalsIgnoreCase(mimeType)
            || PDF_MIME_TYPE.equalsIgnoreCase(mimeType)
            || lowerName.endsWith(".epub")
            || lowerName.endsWith(".pdf");
    }

    private void appendSelectedFile(ContentResolver resolver, Uri uri, JSArray files) {
        String[] projection = new String[] {
            OpenableColumns.DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            OpenableColumns.SIZE,
        };
        try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) {
                return;
            }
            String displayName = getString(cursor, cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME));
            String mimeType = getString(cursor, cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE));
            if (displayName == null || !isSupportedBook(displayName, mimeType)) {
                return;
            }

            JSObject file = new JSObject();
            file.put("name", displayName);
            file.put("size", getLong(cursor, cursor.getColumnIndex(OpenableColumns.SIZE)));
            file.put("uri", uri.toString());
            file.put("type", mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
            file.put("relativePath", displayName);
            files.put(file);
        }
    }

    private void resolveCanceled(PluginCall call) {
        JSObject response = new JSObject();
        response.put("canceled", true);
        response.put("files", new JSArray());
        call.resolve(response);
    }

    private String getDocumentName(ContentResolver resolver, Uri treeUri, String documentId) {
        Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        String[] projection = new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME };
        try (Cursor cursor = resolver.query(documentUri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) {
                return "Selected folder";
            }
            String displayName = getString(cursor, cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME));
            return displayName == null || displayName.isEmpty() ? "Selected folder" : displayName;
        }
    }

    private String appendPath(String parentPath, String name) {
        if (parentPath == null || parentPath.isEmpty()) {
            return name;
        }
        return parentPath + "/" + name;
    }

    private String getString(Cursor cursor, int index) {
        if (index < 0 || cursor.isNull(index)) {
            return null;
        }
        return cursor.getString(index);
    }

    private long getLong(Cursor cursor, int index) {
        if (index < 0 || cursor.isNull(index)) {
            return 0;
        }
        return Math.max(0, cursor.getLong(index));
    }
}
