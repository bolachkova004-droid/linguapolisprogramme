# Подключение регистрации и общей базы

1. Создайте проект на Supabase.
2. Откройте **SQL Editor**, вставьте `schema.sql` и нажмите **Run**.
3. В **Authentication → URL Configuration** добавьте адрес сайта:
   `https://bolachkova004-droid.github.io/linguapolisprogramme/`
4. В **Project Settings → API** скопируйте Project URL и publishable/anon key.
5. Вставьте их в корневой файл `config.js`.
6. Добавьте email преподавателя в `teacherEmails` внутри `config.js`.
7. После регистрации преподавателя выполните в SQL Editor:
   `update public.profiles set role = 'teacher' where email = 'ВАШ_EMAIL';`

Никогда не вставляйте `service_role` key в GitHub или браузер. Для сайта нужен только publishable/anon key. Доступ к данным защищается политиками Row Level Security из `schema.sql`.

В версии v5 регистрация, вход и сохранение выбранного аватара уже работают после заполнения `config.js`. Игровой прогресс пока сохраняется локально в браузере; таблицы для переноса прогресса и ответов в общую базу уже подготовлены.
