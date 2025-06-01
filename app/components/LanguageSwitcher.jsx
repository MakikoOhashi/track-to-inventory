//import { useRouter } from 'next/router';
import { Select } from '@shopify/polaris';
//import { useTranslation } from 'next-i18next';

const t = (key) => {
  const dict = {
    'language.switch': '言語を選択',
    'language.japanese': '日本語',
    'language.english': '英語',
  };
  return dict[key] || key;
};

const LanguageSwitcher = ({ value = 'ja', onChange }) => {
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