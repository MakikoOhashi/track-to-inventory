//app/components/OCRUploader.jsx
import React, { useState, useEffect, useCallback } from "react";
import {
  Card,
  DropZone,
  Text,
  Spinner,
  TextField,
  Button,
  Banner,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import Tesseract from "tesseract.js";



export default function OCRUploader({ shopId, onSaveSuccess }) {
  const { t } = useTranslation("common");
  const [file, setFile] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [ocrTextEdited, setOcrTextEdited] = useState(""); // 編集可能なOCRテキスト
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null); 
  const [fields, setFields] = useState({
    si_number: "",
    supplier_name: "",
    transport_type: "",
    items: []  // JSONBとして保存される配列
  });
  const [error, setError] = useState("");
  const [isClient, setIsClient] = useState(false);

   // クライアント判定（SSR対策）
   useEffect(() => {
    setIsClient(true);
  }, []);


  // PDFをCanvas画像化→OCR
  const pdfToImageAndOcr = useCallback(
  async (pdfFile) => {
    try {
      // PDFをFormDataでAPIに送る
      const formData = new FormData();
      formData.append("file", pdfFile);
      const res = await fetch("/api/pdf2image", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!data.url) throw new Error(t("ocrUploader.convertError"));
  
      // 画像URLをプレビュー用にセット
      setImageUrl(data.url);
      if (typeof window === "undefined") return ""; // SSRでは実行しない
  
      // OCR
      const { data: ocrResult } = await Tesseract.recognize(
        window.location.origin + data.url,
        "eng"
      );
      return ocrResult.text;
    } catch (e) {
      setError(t("ocrUploader.convertError"));
      return "";
    }
  },
  [t]
  );

  // 画像ファイル→OCR
  const imageToOcr = useCallback(
  async (imgFile) => {
    setImageUrl(URL.createObjectURL(imgFile));
    const { data } = await Tesseract.recognize(imgFile, "eng");
    return data.text;
  },
  []
  );

  // 画像アップロードハンドラー
  const handleDrop = useCallback(
    (_dropFiles, acceptedFiles, _rejectedFiles) => {
    const uploadedFile = acceptedFiles[0];
    setFile(uploadedFile);
    //setImageUrl(URL.createObjectURL(uploadedFile));
    setOcrText("");
    setOcrTextEdited("");
    setFields({ si_number: "", supplier_name: "", transport_type: "", items: []  });
    setError("");
    setImageUrl("");
  },
  []
  );

  // OCR実行
  const handleOcr = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      let text = "";
      if (file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf")) {
        text = await pdfToImageAndOcr(file);
      } else if (file.type.startsWith("image/")) {
        text = await imageToOcr(file);
      } else {
        setError(t("ocrUploader.unsupportedFileType"));
      }
      setOcrText(text);
      setOcrTextEdited(text);
      setFields(extractFields(text));
    } finally {
      setLoading(false);
    }
  }, [file, pdfToImageAndOcr, imageToOcr, t]);

    // 商品リスト部分の抽出（必要に応じて正規表現を調整）
    function extractItems(text) {
      const lines = text.split("\n");
      const items = [];
      
      // より柔軟な商品行パターンマッチング
      for (let line of lines) {
        // 商品コード、商品名、数量、価格のパターン
        const patterns = [
          // OEP-SLEDII02 LEDII028 Chip LED Blue ... Use500.00
          /^([A-Z0-9-]+)\s+([A-Z0-9]+)\s+(.+?)\s+.*?Use(\d+\.?\d*)/i,
          // 一般的な商品行パターン
          /^(\S+)\s+(.+?)\s+(\d{1,3}(?:,\d{3})*)\s+.*?(\d+\.?\d*)/i
        ];
        
        for (let pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            items.push({
              name: match[3] ? match[3].trim() : match[2] ? match[2].trim() : "",
              quantity: parseInt(match[3] ? match[3].replace(/,/g, "") : "1") || 1,
              product_code: match[1] || match[2] || "",
              unit_price: match[4] || ""
            });
            break;
          }
        }
      }
      return items;
    }

    // 正規表現で仮抽出
  function extractFields(text) {
    return {
      si_number: text.match(/(?:INV(?:OICE)?(?:\s*(?:NO\.?|#|:|：))?|INVOICE NO\.?)[\s:：#-]*([A-Z0-9\/\-]+)/i)?.[1] ?? "",
      supplier_name: text.match(/(?:SUPPLIER|SHIPPER)[:： ]*([^\n]+)/i)?.[1]?.trim() ?? "",
      transport_type: text.match(/(?:SHIPMENT PER|SHIPPED PER|TRANSPORT TYPE)[:： ]*([^\n]+)/i)?.[1]?.trim() ?? "",
      items: extractItems(text),
    };
  }

   // フォーム編集
  const handleFieldChange = (key, val) => setFields(f => ({ ...f, [key]: val }));

  // 商品リスト編集
  const handleItemChange = (idx, key, value) => {
    setFields(f => ({
      ...f,
      items: f.items.map((item, i) => i === idx ? { ...item, [key]: value } : item)
    }));
  };

  const handleAddItem = () => {
    setFields(f => ({
      ...f,
      items: [...f.items, { name: "", quantity: 1 }]
    }));
  };

  const handleRemoveItem = (idx) => {
    setFields(f => ({
      ...f,
      items: f.items.filter((_, i) => i !== idx)
    }));
  };


   // AI補助（未入力項目のみAIで補完）
   const handleAiAssist = async () => {
    if (!ocrTextEdited.trim()) {
      setError(t("ocrUploader.emptyOcrText"));
      return;
    }
    
    setAiLoading(true);
    setError("");
    
    try {
      console.log("Sending to AI:", { text: ocrTextEdited, fields }); // デバッグ用
      
      const res = await fetch("/api/ai-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: ocrTextEdited,
          fields,
        }),
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const data = await res.json();
      console.log("AI Response:", data); // デバッグ用
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      let aiFields = {};
      try {
        aiFields = JSON.parse(data.result);
      } catch (parseError) {
        console.error("JSON parse error:", parseError, "Raw result:", data.result);
        setError(t("ocrUploader.aiParseFail"));
        return;
      }
      
      // 未入力項目のみ更新
      setFields(currentFields => {
        const updatedFields = { ...currentFields };
        
        // 各フィールドをチェックして未入力の場合のみ更新
        Object.entries(aiFields).forEach(([key, value]) => {
          if (key === 'items' && Array.isArray(value)) {
            // itemsは常に上書き
            updatedFields.items = value;
            }
           else if (key !== 'items') {
            if (!currentFields[key] || currentFields[key].trim() === "") {
              updatedFields[key] = value;
            }
          }
        });
        
        return updatedFields;
      });
      
      setAiResult(aiFields);
      
    } catch (error) {
      console.error("AI assist error:", error);
      setError(`AI補完に失敗しました: ${error.message}`);
    } finally {
      setAiLoading(false);
    }
  };
  
  const handleSaveToSupabase = async () => {
    // shopIdの必須チェック
    if (!shopId) {
      setError(t("ocrUploader.noShopId"));
      return;
    }
    // バリデーション
    if (!fields.si_number) {
      setError(t("ocrUploader.siRequired"));
      return;
    }

    try {
      setLoading(true);
      setError("");

      // データの準備
      const shipmentData = {
        si_number: fields.si_number,
        supplier_name: fields.supplier_name,
        transport_type: fields.transport_type || null,
        items: fields.items || [],// ← JSONBカラムにそのまま保存
        
        status: t("ocrUploader.initialStatus"),
        etd: null,
        eta: null,
        delayed: false,
        clearance_date: null,
        arrival_date: null,
        memo: null,
        is_archived: false,
        shop_id: shopId, // ← 親コンポーネントから受け取ったshopIdを追加
      };

      // デバッグ：送信するデータをコンソールに出力
      console.log('📤 送信データ:', shipmentData);

      // API呼び出し
      const res = await fetch('/api/createShipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment: shipmentData }),
      });
      
      // デバッグ：レスポンスステータスを確認
      console.log('📡 レスポンスステータス:', res.status);
      console.log('📡 レスポンスOK:', res.ok);
      
      // レスポンステキストを取得（エラー詳細のため）
      const responseText = await res.text();
      console.log('📡 レスポンステキスト:', responseText);
      
      // HTTPステータスエラーをチェック
      if (!res.ok) {
        throw new Error(`APIリクエストが失敗しました (ステータス: ${res.status})\nレスポンス: ${responseText}`);
      }
      
      // JSONとして解析を試行
      let json;
      try {
        json = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ JSON解析エラー:', parseError);
        throw new Error(`APIレスポンスのJSON解析に失敗しました: ${responseText}`);
      }
      
      console.log('📥 APIレスポンス:', json);
      
      // APIからのエラーメッセージをチェック
      if (json.error) {
        console.error('❌ APIエラー:', json.error);
        throw new Error(`API処理エラー: ${json.error}`);
      }
      
      // 成功時の処理
      console.log('✅ 保存成功');
      alert('データが正常に保存されました！');
      
      // フォームリセット
      setFields({ si_number: "", supplier_name: "", transport_type: "", items: [] });
      setOcrText("");
      setOcrTextEdited("");
      setImageUrl("");
      setFile(null);

      // 親コンポーネントのコールバック関数を呼び出し
      if (onSaveSuccess) {
        onSaveSuccess();
      }

    } catch (error) {
      console.error('❌ 保存エラーの詳細:', {
        エラーメッセージ: error.message,
        スタックトレース: error.stack,
        フィールドデータ: fields,
        OCRテキスト: ocrTextEdited,
        shopId: shopId
      });
      setError(t("ocrUploader.saveFail", { message: error.message }));
    } finally {
      setLoading(false);
    }
  };

// クライアントでのみレンダリング
  if (!isClient) {
    return (
      <Card sectioned>
        <Spinner />
      </Card>
    );
  }

  return (
    
    <Card sectioned>
      {error && <Banner status="critical">{error}</Banner>}
      
        {/* タイトルを明示的に表示 */}
        <div style={{ marginBottom: '8px' }}>
          <Text as="h2" variant="headingLg">{t("ocrUploader.title")}</Text>
        </div>
      
      <DropZone 
       
        accept="image/*,application/pdf" onDrop={handleDrop}>
        {!file ? (
          <div style={{ textAlign: "center", paddingInlineStartadding: 20, width: "100%" }}>
          <Text variant="bodyMd" as="span">
          {t("ocrUploader.dropzoneText")}
          </Text>
        </div>
        ) : (
          <Text variant="bodyMd">{file.name}</Text>
        )}
      </DropZone>
      {file && (
        <div style={{ marginTop: 16 }}>
          <button onClick={handleOcr} disabled={loading}>
          {t("ocrUploader.ocrButton")}
          </button>
        </div>
      )}
      {loading && <Spinner />}
      

      {/* 画像＋OCRテキスト横並び */}
      {imageUrl && (ocrText || loading) && (
        <div style={{ display: "flex", gap: 32, marginTop: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* 画像プレビュー */}
          <div style={{ minWidth: 280, maxWidth: 400 }}>
            <Text variant="headingMd">{t("ocrUploader.uploadedImage")}</Text>
            <img
              src={imageUrl}
              alt="uploaded"
              style={{
                width: "100%",
                border: "1px solid #eee",
                borderRadius: 4,
                marginTop: 8,
                maxHeight: 400,
                objectFit: "contain"
              }}
            />
          </div>
          {/* OCR編集テキストエリア＋FORM */}
          <div style={{ flex: 1, minWidth: 320 }}>
            <Text variant="headingMd">{t("ocrUploader.ocrResultTitle")}</Text>
            <TextField
              multiline={10}
              value={ocrTextEdited}
              onChange={setOcrTextEdited}
              autoComplete="off"
              placeholder={t("ocrUploader.ocrResultPlaceholder")}
              style={{ fontFamily: "monospace", marginTop: 8, minHeight: 180 }}
            />
            {/* フォーム項目 */}
            <div style={{ marginTop: 16 }}>
            <TextField label={t("ocrUploader.siNumber")} value={fields.si_number} onChange={val => handleFieldChange("si_number", val)} autoComplete="off" />
            <TextField label={t("ocrUploader.supplierName")} value={fields.supplier_name} onChange={val => handleFieldChange("supplier_name", val)} autoComplete="off" />
            <TextField label={t("ocrUploader.transportType")} value={fields.transport_type} onChange={val => handleFieldChange("transport_type", val)} autoComplete="off" />
              {/* items入力欄 */}
              <div style={{ marginTop: 12 }}>
                <Text variant="headingSm">{t("ocrUploader.productList")}</Text>
                {fields.items && fields.items.length > 0 ? (
                  fields.items.map((item, idx) => (
                    <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                      <TextField
                        label={t("ocrUploader.productName")}
                        value={item.name || ""}
                        onChange={v => handleItemChange(idx, "name", v)}
                        autoComplete="off"
                        style={{ width: 160 }}
                      />
                      <TextField
                        label={t("ocrUploader.quantity")}
                        type="number"
                        value={item.quantity || ""}
                        onChange={v => handleItemChange(idx, "quantity", v)}
                        autoComplete="off"
                        style={{ width: 100 }}
                      />
                      <Button size="slim" destructive onClick={() => handleRemoveItem(idx)}>{t("ocrUploader.delete")}</Button>
                    </div>
                  ))
                ) : (
                  <Text color="subdued">{t("ocrUploader.noProductData")}</Text>
                )}
                <Button size="slim" onClick={handleAddItem} style={{ marginTop: 4 }}>{t("ocrUploader.addProduct")}</Button>
              </div>
            </div>
            {/* AI補助ボタン */}
            <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
              <Button onClick={handleAiAssist} disabled={aiLoading}>{t("ocrUploader.aiButton")}</Button>
              {aiLoading && <Spinner />}
              <Button primary onClick={handleSaveToSupabase} disabled={!fields.si_number && !fields.supplier_name && !fields.eta && !fields.amount}>{t("ocrUploader.saveButton")}</Button>
            </div>
          </div>
        </div>
      )}

    </Card>
  );
}