import { useRouter } from 'next/router';
import { Select } from '@shopify/polaris';
import { useTranslation } from 'next-i18next';

const LanguageSwitcher = () => {
  const router = useRouter();
  const { t } = useTranslation('common');

  const handleLanguageChange = (value) => {
    const { pathname, asPath, query } = router;
    router.push({ pathname, query }, asPath, { locale: value });
  };

  const options = [
    { label: t('language.japanese'), value: 'ja' },
    { label: t('language.english'), value: 'en' },
  ];

  return (
    <Select
      label={t('language.switch')}
      options={options}
      value={router.locale}
      onChange={handleLanguageChange}
    />
  );
};

export default LanguageSwitcher;