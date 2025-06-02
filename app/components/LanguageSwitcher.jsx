import { Select } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';

const LanguageSwitcher = ({ value = 'ja', onChange }) => {
  const { t } = useTranslation('common'); // ← これでcommon.jsonから取得

  const options = [
    { label: t('language.japanese'), value: 'ja' },
    { label: t('language.english'), value: 'en' },
  ];

  return (
    <Select
      label={t('language.switch')}
      options={options}
      value={value}
      onChange={onChange}
    />
  );
};


export default LanguageSwitcher;