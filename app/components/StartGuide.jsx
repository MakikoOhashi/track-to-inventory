import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { X, Upload, List, Edit3, CheckCircle } from 'lucide-react';

const StartGuide = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    // 初回表示判定のロジック
    // 実際の実装では localStorage または Supabase user_metadata を使用
    const hasSeenGuide = false; // localStorage.getItem('hasSeenStartGuide') === 'true';
    const isFirstTime = true; // user?.user_metadata?.first_time === true;
    
    if (!hasSeenGuide || isFirstTime) {
      setIsVisible(true);
    }
  }, []);

  const dismissGuide = () => {
    setIsVisible(false);
    // localStorage.setItem('hasSeenStartGuide', 'true');
    // または Supabase でユーザー設定を更新
  };

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  if (!isVisible) return null;

  return (
    <Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200 shadow-sm mb-6 relative">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
              🚀
            </div>
            <h3 className="font-bold text-lg text-blue-900">初めてのご利用ですか？</h3>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={toggleExpanded}
              variant="ghost"
              size="sm"
              className="text-blue-600 hover:text-blue-800"
            >
              {isExpanded ? '折りたたむ' : '詳細を見る'}
            </Button>
            <Button
              onClick={dismissGuide}
              variant="ghost"
              size="sm"
              className="text-gray-500 hover:text-gray-700 p-1"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="pt-0">
          <div className="space-y-4">
            <p className="text-sm text-blue-800 mb-4">
              <strong>3ステップ</strong>で在庫管理を始められます：
            </p>
            
            <div className="grid gap-3">
              <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-blue-100">
                <div className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold">
                  1
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Upload className="w-4 h-4 text-blue-500" />
                    <span className="font-semibold text-gray-900">出荷帳票をアップロード</span>
                  </div>
                  <p className="text-sm text-gray-600">
                    出荷帳票の画像をアップロードすると、OCRが自動で情報を読み取ります
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-blue-100">
                <div className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold">
                  2
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <List className="w-4 h-4 text-blue-500" />
                    <span className="font-semibold text-gray-900">出荷一覧で確認</span>
                  </div>
                  <p className="text-sm text-gray-600">
                    OCR完了後、出荷一覧に自動で反映されます
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-3 bg-white rounded-lg border border-blue-100">
                <div className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold">
                  3
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Edit3 className="w-4 h-4 text-blue-500" />
                    <span className="font-semibold text-gray-900">詳細確認・編集</span>
                  </div>
                  <p className="text-sm text-gray-600">
                    出荷カードをクリックして、詳細情報の確認や編集ができます
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4 p-3 bg-green-50 rounded-lg border border-green-200">
              <CheckCircle className="w-5 h-5 text-green-600" />
              <span className="text-sm text-green-800 font-medium">
                まずは出荷帳票の画像をアップロードしてみましょう！
              </span>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-blue-100 flex justify-between items-center">
            <span className="text-xs text-gray-500">
              このガイドは一度非表示にすると、再表示されません
            </span>
            <Button 
              onClick={dismissGuide} 
              variant="outline" 
              size="sm"
              className="text-blue-600 border-blue-200 hover:bg-blue-50"
            >
              ガイドを閉じる
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
};

export default StartGuide;