import { Select } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';
import { makeLocaleCookie } from '~/utils/locale';

const LanguageSwitcher = ({ value = 'ja', onChange }) => {
  const { t, i18n } = useTranslation('common');

  const options = [
    { label: t('language.japanese'), value: 'ja' },
    { label: t('language.english'), value: 'en' },
  ];

  const handleChange = (selectedValue) => {
    if (onChange) {
      onChange(selectedValue);
    }
    
    // i18nの言語も直接変更
    i18n.changeLanguage(selectedValue);
    
    // localStorageにも保存
    localStorage.setItem('i18nextLng', selectedValue);
    document.cookie = makeLocaleCookie(selectedValue);
  };

  return (
    <Select
      label={t('language.switch')}
      options={options}
      value={value}
      onChange={handleChange}
    />
  );
};

export default LanguageSwitcher;
