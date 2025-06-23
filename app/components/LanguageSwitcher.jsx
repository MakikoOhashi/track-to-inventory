import { Select } from '@shopify/polaris';
import { useTranslation } from 'react-i18next';

const LanguageSwitcher = ({ value = 'ja', onChange }) => {
  const { t } = useTranslation('common');

  const options = [
    { label: t('language.japanese'), value: 'ja' },
    { label: t('language.english'), value: 'en' },
  ];

  const handleChange = (selectedValue) => {
    if (onChange) {
      onChange(selectedValue);
    }
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